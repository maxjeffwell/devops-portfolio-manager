# Dedicate ASUSTOR USB NIC (.149) to Garage RPC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ASUSTOR Garage node's inter-node replication RPC off the busy eth0/.142 onto the idle USB NIC eth2/.149, after first eliminating that NIC's periodic USB resets.

**Architecture:** Single lever — change the NAS Garage node's advertised `rpc_public_addr` from `192.168.50.142:3901` to `192.168.50.149:3901`. Garage already binds all interfaces and the container is host-networked, so no rebind/Docker-network change is needed. A USB-NIC power-management fix (gated by a soak test) is the prerequisite, persisted via an ASUSTOR autostart hook.

**Tech Stack:** ASUSTOR ADM (busybox userland), Docker (docker-ce AppCentral, host-networked Garage `v2.2.0`), Linux sysfs USB power management (`r8152`), Kubernetes (`kubectl exec` into in-cluster `garage` pods for cluster status), WireGuard overlay.

**Runner legend:**
- `[agent]` — runnable from this session over non-root SSH (`ssh -p 22 maxjeffwell@192.168.50.142`) or `kubectl` on marmoset.
- `[user-sudo]` — must be run by the user on the ASUSTOR with root/docker (SSH in, then `sudo -i`). The session has no passwordless sudo there.

**Reference IDs (captured 2026-06-02):**
- NAS Garage node id: `332f5e30f99d2a88` (hostname `AS5402T-A7F3`, zone `nas`).
- USB NIC: `eth2`, MAC `00:e0:4c:67:11:3c`, driver `r8152`, controller RTL8156 (`0bda:8156`). USB path `2-1.1.2` **pre-relocation** (changes after Task 3; the keep-awake script resolves the path dynamically from `eth2`, so it doesn't depend on the value).
- Garage cluster: 6 HEALTHY nodes. S3 port 3900, RPC port 3901, admin 3903.

---

## Task 1: Pre-flight baseline + rollback capture

Capture everything needed to (a) prove the change worked and (b) roll back. Nothing is modified.

**Files:** none (writes a local capture file under `/home/maxjeffwell/asustor-garage-nic-baseline.txt`).

- [x] **Step 1: Capture current Garage cluster view + the NAS node's advertised address** `[agent]`

Run:
```bash
GPOD=$(kubectl get pods -n monitoring -o name | grep garage | head -1)
kubectl exec -n monitoring "${GPOD##*/}" -c garage -- /garage status | tee /home/maxjeffwell/asustor-garage-nic-baseline.txt
```
Expected: a `==== HEALTHY NODES ====` table with **6** nodes, and the line for `332f5e30f99d2a88` showing `192.168.50.142:3901`. Record that `.142:3901` value — it is the rollback target.

- [x] **Step 2: Capture baseline NIC byte counters on the NAS** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 \
  'date; grep -E "eth0:|eth2:" /proc/net/dev' | tee -a /home/maxjeffwell/asustor-garage-nic-baseline.txt
```
Expected: two lines (eth0, eth2) with their cumulative rx/tx bytes. These anchor the "traffic moved" check in Task 8.

- [x] **Step 3: Confirm cloud-peer reachability to .149 (re-verify feasibility)** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@86.48.29.183 \
  'for ip in 192.168.50.142 192.168.50.149; do printf "%s " $ip; timeout 5 bash -c "echo > /dev/tcp/$ip/3901" 2>&1 && echo OPEN || echo UNREACHABLE; done'
```
Expected: `192.168.50.142 OPEN` and `192.168.50.149 OPEN`. If `.149` is UNREACHABLE, **stop** — repointing would drop the cloud peers; resolve overlay routing first.

- [x] **Step 4: Commit the baseline capture into the repo for the record** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
mkdir -p docs/superpowers/plans/artifacts
cp /home/maxjeffwell/asustor-garage-nic-baseline.txt docs/superpowers/plans/artifacts/2026-06-02-asustor-garage-nic-baseline.txt
git add docs/superpowers/plans/artifacts/2026-06-02-asustor-garage-nic-baseline.txt
git commit -m "chore: capture ASUSTOR garage/NIC baseline before .149 repoint"
```
Expected: commit succeeds.

---

## Task 2: Diagnose the USB NIC reset cause

Identify *why* eth2 re-enumerates (`r8152 … reset SuperSpeed USB device` + `netif eth2 already exist in list, can't add it`). Prime suspect: USB autosuspend / selective-suspend power management.

**Files:** none (read-only).

- [x] **Step 1: Capture the reset cadence from the kernel log** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 \
  'dmesg | grep -iE "r8152|2-1.1.2|eth2" | tail -30'
```
Expected: one or more `reset SuperSpeed USB device` lines. Note the jiffies timestamps to estimate interval (≈ every ~2h observed).

- [x] **Step 2: Read the USB device's power-management state** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 '
for p in /sys/bus/usb/devices/2-1.1.2/power/control \
         /sys/bus/usb/devices/2-1.1.2/power/autosuspend_delay_ms \
         /sys/class/net/eth2/device/../power/control; do
  echo -n "$p = "; cat "$p" 2>&1
done'
```
Expected: likely `control = auto` and a positive `autosuspend_delay_ms` — confirming autosuspend is enabled (the thing to disable in Task 3). If `control = on` already, autosuspend is *not* the cause → record this and escalate to Task 2 Step 3.

> **RESULT (2026-06-02): `control = on` already** (autosuspend not the cause). Reset signature = `USB disconnect → re-enumerate → "Failed to set configuration 1"` of RTL8156 (`0bda:8156`); frequency low (single cluster in logs). **Root cause = USB-hub power contention:** NIC (`2-1.1.2`) shares its upstream 4-port hub `2-1` with a 5-bay Sabrent disk dock (`2-1.2.x`, Garage storage). → Task 3 rewritten to a physical relocation; the old "disable autosuspend" task is obsolete.

- [x] **Step 3: Rule out link-layer EEE / cable as a secondary cause** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 \
  'ethtool eth2 2>/dev/null | grep -iE "speed|duplex|link"; ethtool --show-eee eth2 2>/dev/null | grep -i eee'
```
Expected: `Speed: 2500Mb/s`, `Link detected: yes`. If EEE is enabled, note it as a follow-up disable (`ethtool --set-eee eth2 eee off`) but proceed — USB re-enumeration is a device-level event, not an EEE blink.

---

## Task 3: Relocate the NIC off the disk-dock hub + re-map (physical-fix-first)

Decouple the NIC's USB power domain from the 5-bay Sabrent dock so Garage storage I/O can't brown it out. Autosuspend is already off, so there is no software fix — this is a physical move.

**Files:** none (hardware change + sysfs re-map).

> **RESULT (2026-06-02 21:05 EDT): relocated to `2-2.3` on the `2-2` hub.** `.149` followed (MAC DHCP); carrier up, 2500 Mb/s; `power/control = on`. New hub-mates: Patriot flash + ONE single disk (`2-2.4`) — **zero** Sabrent Dock Disks (the 5-bay dock stayed on `2-1`). `<NEW_USB_PATH>` = `2-2.3`. Soak start marker: 3 historical eth2 disconnects; uptime 1415097s.

- [x] **Step 1: Physically move the NIC's USB plug** `[user-physical]`

The NIC currently shares a 4-port USB hub with the 5-bay Sabrent disk dock. Unplug the NIC and move it to a port whose chain does **not** include that dock, in priority order:
1. A free NAS root port directly (e.g. a front port) — dedicated power, fewest hops.
2. The other 4-port hub (the one carrying only a flash drive + a single device).

`.149` follows automatically (MAC-based DHCP reservation `00:e0:4c:67:11:3c`). No software change needed for the IP.

- [x] **Step 2: Confirm the NIC re-appeared with .149 and capture its NEW sysfs path** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 '
ip -o addr show | grep 192.168.50.149
NICDEV=$(readlink -f /sys/class/net/eth2/device)
echo "eth2 device path: $NICDEV"
echo "$NICDEV" | grep -oE "usb2/[0-9.-]+/[0-9.-]+" | tail -1
echo -n "carrier="; cat /sys/class/net/eth2/carrier'
```
Expected: `.149` still on `eth2`, `carrier=1`, and a device path that **no longer contains the `2-1.2` dock subtree**. Record the new top-level path (e.g. `2-2.3` or a direct root port) as `<NEW_USB_PATH>` — Task 4 uses it.

- [x] **Step 3: Verify the NIC is now on a hub WITHOUT the Sabrent dock** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 '
for d in /sys/bus/usb/devices/<NEW_USB_PATH_PARENT>*/product; do echo -n "$d="; cat "$d" 2>/dev/null; done'
```
Expected: the NIC's new sibling list contains **no** "Sabrent Dock Disk" entries. If it still shares a hub with dock disks, move to a different port and repeat Step 2. Record the timestamp — Task 5 soak starts now.

---

## Task 4: Author + install a persistent keep-awake autostart hook (defensive)

Autosuspend is already off, so this is **defensive hardening**, not the primary fix (the relocation in Task 3 is). It pins `power/control = on` after reboot in case a port default comes up as `auto`. The script resolves the USB power node **dynamically from `eth2`** so it survives the relocation (and any future port change) — no hardcoded bus path. ASUSTOR does not reliably run init hooks, so wire it into a verified autostart path and track the script in Git.

**Files:**
- Create: `scripts/asustor/usb-nic-keepawake.sh` (in this repo, for version control)
- Install target on NAS: an ADM-honored autostart entry (exact path confirmed in Step 2).

- [ ] **Step 1: Write the keep-awake script in the repo** `[agent]`

Create `scripts/asustor/usb-nic-keepawake.sh`:
```bash
#!/bin/sh
# Pin the r8152 USB 2.5GbE NIC (eth2/.149) USB device active (defensive).
# Resolves the power node dynamically from the interface, so it works regardless of
# which USB port the NIC is plugged into (path changes on relocation). Idempotent.
IFACE=eth2
DEV=$(readlink -f "/sys/class/net/$IFACE/device" 2>/dev/null)   # .../2-X.Y/2-X.Y:1.0
USB_DEV="$(dirname "$DEV")/power"                                # .../2-X.Y/power
[ -w "$USB_DEV/control" ] && echo on > "$USB_DEV/control"
[ -w "$USB_DEV/autosuspend_delay_ms" ] && echo -1 > "$USB_DEV/autosuspend_delay_ms"
logger -t usb-nic-keepawake "$IFACE power=$USB_DEV control=$(cat "$USB_DEV/control" 2>/dev/null)"
```

- [ ] **Step 2: Identify the working ADM autostart path on the NAS** `[user-sudo]`

On the ASUSTOR (`sudo -i`), find which autostart mechanism already runs (look for an existing user-start hook, mirroring how garage/NFS are started):
```bash
ls -la /usr/local/etc/init.d/ 2>/dev/null | head
ls -la /volume1/.@plugins 2>/dev/null | head
grep -rsl "S97\|user-start\|services-start" /usr/local/etc /usr/builtin/etc 2>/dev/null | head
```
Expected: locate the same autostart file that launches the Garage container / NFS (the proven-on-boot hook). Record its path as `<AUTOSTART>`.

- [ ] **Step 3: Install the script and register it in the autostart hook** `[user-sudo]`

On the ASUSTOR (`sudo -i`), with `<AUTOSTART>` from Step 2 (example uses an init.d script + the existing services hook):
```bash
install -m 0755 /dev/stdin /usr/local/sbin/usb-nic-keepawake.sh <<'EOF'
#!/bin/sh
IFACE=eth2
DEV=$(readlink -f "/sys/class/net/$IFACE/device" 2>/dev/null)
USB_DEV="$(dirname "$DEV")/power"
[ -w "$USB_DEV/control" ] && echo on > "$USB_DEV/control"
[ -w "$USB_DEV/autosuspend_delay_ms" ] && echo -1 > "$USB_DEV/autosuspend_delay_ms"
logger -t usb-nic-keepawake "$IFACE power=$USB_DEV control=$(cat "$USB_DEV/control" 2>/dev/null)"
EOF
# Register: append an invocation to the proven autostart hook if not already present
grep -q usb-nic-keepawake <AUTOSTART> || echo '/usr/local/sbin/usb-nic-keepawake.sh' >> <AUTOSTART>
```
Expected: script installed `0755`; `<AUTOSTART>` now references it.

- [ ] **Step 4: Dry-run the installed script and confirm it holds state** `[user-sudo]`

On the ASUSTOR (`sudo -i`):
```bash
/usr/local/sbin/usb-nic-keepawake.sh
DEV=$(readlink -f /sys/class/net/eth2/device); cat "$(dirname "$DEV")/power/control"   # expect: on
```
Expected: `on`. (Reboot-persistence is verified separately in Task 9, which carries an ASUSTOR-reboot caution.)

- [ ] **Step 5: Commit the tracked script** `[agent]`

Run:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add scripts/asustor/usb-nic-keepawake.sh
git commit -m "feat(asustor): keep-awake hook to stop eth2 USB NIC re-enumeration"
```
Expected: commit succeeds.

---

## Task 5: Soak to MEASURE reset frequency (≥3 days) — gate by decision rule

Reframed from "zero resets" to "measure the real frequency after relocation." A rare (~5 s, infrequent) re-enumeration is acceptable for Garage RPC, which auto-reconnects. The point of the soak is to confirm relocation dropped the rate to that acceptable level — and to drive the dock disks (Garage I/O) so any power-contention reset would surface.

**Files:** none.

- [ ] **Step 1: Record the soak start marker** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 \
  'echo "SOAK_START $(date) uptime=$(cut -d. -f1 /proc/uptime)s"; echo -n "disconnects-so-far="; dmesg | grep -c "USB disconnect"'
```
Expected: a baseline `USB disconnect` count and start time. New re-enumerations are counted relative to this.

- [ ] **Step 2: Generate disk-dock load to provoke contention, then poll** `[agent]`

Trigger Garage/disk activity on the dock (e.g. a Velero backup, or a large read of `/share/USB21`) so the dock draws power while the NIC is active, then poll periodically over ≥3 days (a `/loop` every few hours works):
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 \
  'date; echo -n "carrier="; cat /sys/class/net/eth2/carrier; echo -n "disconnects="; dmesg | grep -c "USB disconnect"; dmesg | grep -E "Failed to set configuration|2-.*USB disconnect" | tail -3'
```
Expected (healthy): `carrier=1` every check; the `disconnects` count does **not** climb (or climbs only negligibly) even while the dock is under load.

- [ ] **Step 3: Evaluate the gate (decision rule)** `[agent]`

- **PASS** — re-enumerations ≤ ~1 per several days (each ~5 s) and none correlated with dock I/O → relocation worked; proceed to Task 6.
- **MARGINAL** — occasional resets but only under heavy concurrent dock load → consider a powered USB hub for the dock (or the NIC) to fully separate power domains; re-soak.
- **FAIL** — still frequent re-enumerations after relocation → **STOP**. Do not repoint Garage. Escalate: powered hub, a different physical port, or abandon the move and leave Garage on `.142` (NIC deemed unfit). Re-open Task 3.

---

## Task 6: Locate the Garage config + capture the exact rollback value

Find where `rpc_public_addr` is actually set (bind-mounted file vs. env) before changing anything.

**Files:** the container's `garage.toml` (host path discovered here).

- [ ] **Step 1: Identify the Garage container and its config source** `[user-sudo]`

On the ASUSTOR (`sudo -i`):
```bash
CID=$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' | grep -i garage | awk '{print $1}')
echo "container=$CID"
docker inspect "$CID" --format '{{json .Mounts}}' | tr ',' '\n' | grep -i toml
docker inspect "$CID" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i rpc
```
Expected: either a bind-mount whose `Source` is the host path of `garage.toml`, **or** an env var like `GARAGE_RPC_PUBLIC_ADDR=...`. Record which it is as `<CONFIG_TARGET>`.

- [ ] **Step 2: Read the current rpc_public_addr from the real source** `[user-sudo]`

On the ASUSTOR (`sudo -i`):
```bash
# If file (replace with the Source path from Step 1):
grep -nE 'rpc_public_addr|rpc_bind_addr' <host-garage.toml-path>
# If env: docker inspect already showed it in Step 1.
```
Expected: `rpc_public_addr = "192.168.50.142:3901"`. Confirm it matches the Task 1 rollback value.

- [ ] **Step 3: Back up the config source** `[user-sudo]`

On the ASUSTOR (`sudo -i`):
```bash
cp -a <host-garage.toml-path> <host-garage.toml-path>.bak.2026-06-02
ls -la <host-garage.toml-path>.bak.2026-06-02
```
Expected: timestamped backup exists. (If env-based, instead record the full current `docker run`/compose invocation.)

---

## Task 7: Repoint rpc_public_addr .142 → .149 + restart

The actual change. One value.

**Files:** the `<CONFIG_TARGET>` from Task 6.

- [ ] **Step 1: Edit the advertised address** `[user-sudo]`

On the ASUSTOR (`sudo -i`):
```bash
# File-based:
sed -i 's/rpc_public_addr = "192.168.50.142:3901"/rpc_public_addr = "192.168.50.149:3901"/' <host-garage.toml-path>
grep rpc_public_addr <host-garage.toml-path>
```
Expected: line now reads `192.168.50.149:3901`. (Env-based: change the env value in the container's launch definition instead.)

- [ ] **Step 2: Restart the Garage container** `[user-sudo]`

On the ASUSTOR (`sudo -i`) — re-derive `CID` in case this is a fresh shell:
```bash
CID=$(docker ps --format '{{.ID}} {{.Names}}' | grep -i garage | awk '{print $1}')
docker restart "$CID"
sleep 5
docker logs --tail 20 "$CID"
```
Expected: container restarts; logs show Garage starting and binding `:::3901` without fatal errors.

- [ ] **Step 3: Confirm the NAS node re-listens on .149** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 'netstat -tln | grep ":3901 "'
```
Expected: still `:::3901 LISTEN` (binds all interfaces — unchanged; the change is the *advertised* address, not the bind).

---

## Task 8: Verify cluster health + traffic migration (the "green")

Prove the cluster is intact AND that bytes now flow over eth2.

**Files:** none.

- [ ] **Step 1: Verify all 6 nodes healthy with the NAS at .149** `[agent]`

Run:
```bash
GPOD=$(kubectl get pods -n monitoring -o name | grep garage | head -1)
kubectl exec -n monitoring "${GPOD##*/}" -c garage -- /garage status
```
Expected: `==== HEALTHY NODES ====` with **6** nodes; node `332f5e30f99d2a88` now shows `192.168.50.149:3901`; **no** node under a `FAILED`/`UNREACHABLE` section — especially the two cloud nodes (`86c4aee9…`, `04c74cc7…`).

- [ ] **Step 2: Generate replication load via a backup** `[agent]`

Run:
```bash
velero backup create verify-nic-149-$(date +%H%M) --include-namespaces monitoring --wait 2>/dev/null \
  || kubectl exec -n monitoring "${GPOD##*/}" -c garage -- /garage stats | head
```
Expected: a backup that writes objects (replicated to the NAS), or Garage stats showing activity. The point is to push real RPC at the NAS node.

- [ ] **Step 3: Confirm eth2 counters climbed and eth0 did not carry the Garage share** `[agent]`

Run:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 'date; grep -E "eth0:|eth2:" /proc/net/dev'
```
Expected: compared to the Task 1 baseline, **eth2 rx/tx bytes increased substantially** (now carrying replication), while eth0's growth is just its normal serving traffic. This is the success signal: the USB NIC is doing real work.

- [ ] **Step 4: Confirm no new backup failures attributable to the change** `[agent]`

Run:
```bash
kubectl get backups -n velero --sort-by=.metadata.creationTimestamp | tail -5
```
Expected: recent backups `Completed` (not new `PartiallyFailed`). Cross-check against the Velero stabilization effort — pre-existing failures are not regressions from this change.

---

## Task 9: (Optional, FLAGGED) reboot-persistence verification

⚠️ **CAUTION:** Rebooting the ASUSTOR takes down Jellyfin, all NFS shares, and the Garage node. Memory records a **loopback-NFS boot deadlock** risk ("Don't reboot ASUSTOR until the S97lvm-nfs loopback block is removed"). Do **not** run this task until that block is confirmed removed. This task is opt-in and may be deferred indefinitely; the config change (Task 7) already persists via the bind-mounted file, and only the USB power fix depends on the Task 4 autostart hook.

**Files:** none.

- [ ] **Step 1: Confirm the loopback-NFS deadlock block is cleared** `[user-sudo]`

On the ASUSTOR (`sudo -i`): verify `S97lvm-nfs` no longer contains the `127.0.0.1` loopback NFS mount. Do not proceed otherwise.

- [ ] **Step 2: Reboot and verify both fixes survived** `[user-sudo]` then `[agent]`

After a clean reboot, run `[agent]`:
```bash
ssh -p 22 -o BatchMode=yes maxjeffwell@192.168.50.142 \
  'cat /sys/bus/usb/devices/2-1.1.2/power/control; logger -t check done'
GPOD=$(kubectl get pods -n monitoring -o name | grep garage | head -1)
kubectl exec -n monitoring "${GPOD##*/}" -c garage -- /garage status | grep 332f5e30
```
Expected: `on` (autostart hook held) and the NAS node back HEALTHY at `192.168.50.149:3901`.

---

## Task 10: Record outcome

**Files:**
- Modify: the spec's Open Items / a short outcome note.

- [ ] **Step 1: Note resolved open items + commit** `[agent]`

Append to the spec (`docs/superpowers/specs/2026-06-02-asustor-garage-rpc-usb-nic-design.md`) the discovered facts: exact `<host-garage.toml-path>`, the r8152 disable knob used, and the `<AUTOSTART>` path. Then:
```bash
cd /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager
git add docs/superpowers/specs/2026-06-02-asustor-garage-rpc-usb-nic-design.md
git commit -m "docs: record resolved open items for .149 garage repoint"
```
Expected: commit succeeds. Consider a memory entry capturing the new NAS Garage RPC address and the keep-awake hook for future-you.

---

## Rollback (any time)

On the ASUSTOR (`sudo -i`):
```bash
cp -a <host-garage.toml-path>.bak.2026-06-02 <host-garage.toml-path>   # or revert the env value
CID=$(docker ps --format '{{.ID}} {{.Names}}' | grep -i garage | awk '{print $1}')
docker restart "$CID"
```
Then `[agent]` verify with Task 8 Step 1 that node `332f5e30f99d2a88` is HEALTHY back at `192.168.50.142:3901`. One advertised address ⇒ rollback is instant.
