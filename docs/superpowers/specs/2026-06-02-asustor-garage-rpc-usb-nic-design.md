# Dedicate ASUSTOR USB NIC (.149) to Garage RPC — Design Spec

**Date:** 2026-06-02
**Status:** Approved (design); pending implementation plan
**Branch:** `infra/asustor-garage-rpc-usb-nic`
**Host of record:** ASUSTOR `AS5402T-A7F3` (Garage node `332f5e30f99d2a88`, zone `nas`, 2.2 TB)
**Canonical config:** Garage runs as a **host-networked Docker container** on the ASUSTOR (docker-ce AppCentral). The advertised RPC address (`rpc_public_addr`) lives in that container's `garage.toml` (bind-mount path to be confirmed via `docker inspect`) or its env. This is **not** a Git-managed manifest — the apply target is the NAS itself, run by the user under sudo. This spec is the record of intent; the runbook below is the implementation.

---

## 1. Problem Statement

The ASUSTOR has three 2.5 GbE NICs (all up, MTU 9000):

| NIC | IP | Bus / driver | Role today | Lifetime traffic (16d uptime) |
|-----|----|--------------|-----------|-------------------------------|
| eth0 | .142 | PCIe / `r8125` | Default route + active serving; **also the Garage RPC address** | RX 377 GB / TX 479 GB |
| eth1 | .133 | PCIe / `r8125` | Jellyfin **TV Shows** NFS | RX 84 GB / TX 128 GB |
| **eth2** | **.149** | **USB / `r8152`** | Nominally Jellyfin **Movies** NFS | **RX 37 MB / TX 12 MB** |

eth2/.149 moves ~0 bytes — the intended Movies-NFS split is not actually traversing it. The goal is to give `.149` a genuine, steady workload as a **dedicated isolated path**.

**Root cause of the idle NIC:** The ASUSTOR Garage node advertises `rpc_public_addr = 192.168.50.142:3901` (**eth0**). It is the 2.2 TB node and holds a replica of effectively everything (all Velero/kopia backups). Every peer that replicates an object to the NAS lands that RPC ingress on **eth0** — competing with the default-route serving traffic — while the idle USB NIC sits at ~0 bytes. The backup S3 front door (`garage.monitoring.svc:3900`, in-cluster ClusterIP) is never the NAS's concern; the NAS only ever receives **replication RPC**, and that RPC currently uses eth0.

## 2. Goals / Non-Goals

**Goals:**
- Make eth2/.149 the NAS Garage node's dedicated RPC interface, moving all inter-node replication ingress off eth0.
- Do so **without** destabilizing the (already fragile) backup pipeline — USB-NIC stability gated first, instant rollback available.
- Persist both the NIC-stability fix and the address change across reboot (ASUSTOR autostart is unreliable by default).

**Non-Goals (explicit):**
- Changing how S3 **clients** reach Garage (BSL `s3Url` stays `garage.monitoring.svc.cluster.local:3900`; no Velero/BSL/DNS changes). The lever is purely the NAS node's *advertised RPC address*.
- Per-peer / split-horizon RPC addressing (Approach B). Rejected in favor of the single-value repoint (Approach A) for simplicity; the single advertised address is also what makes rollback instant.
- Touching eth0/.142 or eth1/.133 roles, the Garage layout, replication factor, or zones.
- Repurposing `.149` for any connection-fragile workload (iSCSI/Postgres) — the USB NIC's reset behavior makes Garage RPC (reconnect-tolerant) the deliberate choice.

## 3. Architecture & Data Flow

Single lever: the NAS node's `rpc_public_addr`.

```
Before:  peer ──RPC──> 192.168.50.142:3901  ──> arrives on NAS eth0  (busy)
After:   peer ──RPC──> 192.168.50.149:3901  ──> arrives on NAS eth2  (USB, idle)
```

Peers and their path to the NAS:
- **LAN:** `debian-marmoset` (.152) → over the 2.5 GbE switch → NAS eth2.
- **Overlay:** `vmi2951245`, `vmi3115606` → `wg0` (192.168.50.0/24 advertised into the mesh) → NAS eth2.
- **Other:** Synology (`boom_boom`), AX86U-Pro router → existing overlay/LAN path, now terminating on eth2.

Garage already binds **all** interfaces (`rpc_bind_addr` → `:::3901` confirmed listening), so no rebind is required — only the advertised address changes. Host-networked container already sees eth2.

**Feasibility verified (2026-06-02):** from cloud node `vmi2951245`, `192.168.50.149:3901` is **OPEN** over `wg0` (route `192.168.50.149 dev wg0 src 10.0.0.1`), identical to `.142`. Repointing therefore does **not** strand the cloud peers.

## 4. Phase 1 — Stabilize the USB NIC (prerequisite gate)

**CORRECTED 2026-06-02 (post-diagnosis).** The reset is **not** a power-management/autosuspend timer — `/sys/bus/usb/devices/2-1.1.2/power/control` is already `on` (autosuspend effectively disabled), so the originally-planned "disable autosuspend" fix is a no-op. The real signature is a **USB disconnect → re-enumerate → `Failed to set configuration 1` → repeated resets** of a Realtek **RTL8156** dongle (`0bda:8156`) — an electrical/enumeration fault. Frequency is **low and was overstated earlier**: dmesg + `/var/log/messages` show a *single* re-enumeration cluster (~2.5h before triage), not a 2-hour cycle.

**Root cause (hardware topology):** eth2 (`2-1.1.2`) sits two hubs deep and **shares its upstream 4-port USB3.0 hub (`2-1`) with a 5-bay Sabrent disk dock** (`2-1.2.1.1–.4`, `2-1.2.2` — "Sabrent Dock Disk 1–5" via ASMedia/JMicron SATA bridges), almost certainly Garage's USB storage. Five disks + a 2.5G NIC on one upstream USB port = power-brownout territory. This is doubly bad for *this* design: Garage replica writes would spike the dock's draw **and** drive NIC RPC on the same hub at once. The other root-hub port (`2-2`) is lightly loaded (a flash drive + one device) and dock-free.

**Approach: physical-fix-first (decided 2026-06-02).** Decouple the NIC's power domain from the disk dock *before* any soak or repoint.

1. **Relocate the NIC** off the `2-1` hub to a port whose chain excludes the Sabrent dock — priority: (a) a free NAS root port directly (fewest hops, dedicated power), else (b) the `2-2` hub. `.149` follows automatically (MAC-based DHCP reservation `00:e0:4c:67:11:3c`). The NIC's sysfs path changes from `2-1.1.2` to a new value — re-map it after the move (affects the keep-awake script path, not the IP).
2. **Re-map + light hardening** — record the new USB path; keep `power/control = on`; optionally disable EEE (`ethtool --set-eee eth2 eee off`, currently "enabled - inactive") and install the keep-awake hook pointed at the new path (defensive, persisted via a verified ASUSTOR autostart).
3. **Soak to MEASURE frequency** (reframed gate) — monitor ≥3 days. **GATE (decision rule, not zero-tolerance):** if re-enumerations are rare (≤ ~1 per several days, ~5 s each), that is **acceptable** for Garage RPC (peers auto-reconnect; a rare brief blip is negligible) → proceed to Phase 2. If still frequent after relocation → escalate (powered hub / different physical port / abandon and leave Garage on `.142`).

## 5. Phase 2 — Repoint Garage RPC to .149 (user runs under sudo)

1. **Locate config** — `docker inspect` the Garage container to find the `garage.toml` bind-mount on the host (and confirm whether `rpc_public_addr` is set in the file vs. an `-e` env var).
2. **Edit** — `rpc_public_addr`: `192.168.50.142:3901` → `192.168.50.149:3901`.
3. **Restart** the Garage container.
4. **Verify cluster** — `garage status` from an in-cluster pod (`kubectl exec -n monitoring garage-0 -c garage -- /garage status`) shows node `332f5e30` **HEALTHY** at `192.168.50.149:3901` and **all 6 nodes connected** — cloud peers especially.

## 6. Validation / Success Criteria

- `garage status` → NAS node healthy at `.149`; no peer dropped (6/6 healthy).
- **Traffic moved:** sample `/proc/net/dev` deltas on the NAS under backup load — eth2 RX/TX climb; eth0's Garage share drops. Trigger a Velero backup to generate replication and confirm bytes land on eth2.
- Backups still complete — no new `PartiallyFailed` attributable to the change (cross-check against the Velero stabilization effort).

## 7. Rollback

Single-value revert: `rpc_public_addr` → `192.168.50.142:3901`, restart container. One advertised address ⇒ rollback is instant and low-risk. Keep the prior value noted before editing.

## 8. Risks

| Risk | Mitigation |
|------|------------|
| USB re-enumeration during a write-quorum window → `PartiallyFail` | Physical-fix-first (move NIC off the disk-dock hub) removes the power-contention trigger; reframed soak confirms low frequency; Garage auto-reconnect + instant rollback. |
| Garage's own storage I/O on the shared hub triggers the NIC reset | Relocate NIC to a dock-free port (`2-2` or a root port) so storage power spikes and NIC RPC no longer share an upstream USB port. |
| ASUSTOR autostart drops the keep-awake hook / config on reboot | Wire into a verified autostart hook; reboot-test before considering done (gated behind the loopback-NFS deadlock caution, see plan Task 9). |
| Cloud peer unreachable at .149 | Verified OPEN over `wg0` on 2026-06-02 (re-confirmed during Task 1); re-confirm post-change. |
| `rpc_public_addr` is image/env-baked, not a host file | `docker inspect` (plan Task 6) determines the real edit point before any change. |

## 9. Open Items (resolve during implementation)

- Exact host path of the container's `garage.toml` (or the env var carrying `rpc_public_addr`).
- **New USB sysfs path of the NIC after physical relocation** (currently `2-1.1.2`; changes when moved) — update the keep-awake script path to match.
- Whether relocation alone drops the re-enumeration frequency to acceptable, or a powered hub is also needed.
- The specific ASUSTOR autostart file to persist the keep-awake hook in.
- Confirm Garage v2.2.0 re-advertises the new address to all peers on container restart (expected; verify post-change).

**Resolved during Task 1–2 diagnosis (2026-06-02):** autosuspend is *not* the cause (`power/control = on` already); reset frequency is low (single cluster in logs, not ~2h); root cause is USB-hub power contention with the 5-bay Sabrent dock on the shared `2-1` hub. Cloud reachability to `.149:3901` re-verified OPEN.

## 10. Outcome (2026-06-02) — ACHIEVED

All inbound Garage RPC to the NAS now lands on `.149`/eth2; `.142`/eth0 = 0 Garage connections; all 6 nodes HEALTHY (incl. vmi3115606). Three fixes were required:

1. **NIC relocation** `2-1.1.2` → `2-2.3` — off the 5-bay Sabrent dock hub. Root cause of resets was **USB power contention, not autosuspend** (`power/control` already `on`). 0 resets since.
2. **vmi3115606 wg routing fix** (the partition blocker) — it routed `192.168.50.0/24` over a **dead `wg1`**; moved it to the working `wg0` by adding `192.168.50.0/24` to the NAS wg0 peer (`2x7A34Pk…`) AllowedIPs (matching vmi2951245). Persisted in `/etc/wireguard/wg0.conf`+`wg1.conf`.
3. **The real lever was `rpc_bind_addr`, not `rpc_public_addr`.** Garage's mesh reuses any working connection, so advertising `.149` did nothing — had to **bind the listener to `.149` only** (`rpc_bind_addr = "192.168.50.149:3901"`). A first attempt partitioned vmi3115606 (couldn't reach `.149`) and was reverted; only safe after fix #2.

**Residual / follow-ups:**
- Keep-awake hook installed + running but **boot-autostart not yet wired** (Task 9, gated behind the loopback-NFS reboot caution).
- **`.149`-only bind couples Garage startup to the USB NIC being up.** If `.149` is down at start, garage won't bind. Revert: `rpc_bind_addr` → `[::]:3901` + `docker restart garage`.
- Rotate `ASUSTOR_GARAGE_RPC_SECRET` / `ASUSTOR_GARAGE_ADMIN_TOKEN` via Doppler (exposed in session transcript during discovery).
