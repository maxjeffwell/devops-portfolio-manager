# Headscale cold standby on m920s — design

Date: 2026-10-23
Status: reviewed 2026-10-23 (builder check done, operator answers folded in)

## Intent

headscale is the tailnet control plane and k3s rides the tailnet. Today it runs
natively on dm (debian-marmoset, a ThinkPad X1 Carbon Gen 10). If dm dies, no
node can join, re-auth, or receive ACL/DNS changes until dm is rebuilt. Existing
sessions keep working (node keys never expire, DERP is Tailscale's public relay),
so the outage is mild but open-ended.

This design adds a second **native** headscale install on m920s that is kept in
sync with dm but not running, plus **one command** that makes it live and one
that hands control back. No automatic failover.

The 2026-07-11 circular outage rules out anything that runs headscale inside
k3s or depends on the tailnet. Everything here is native systemd on LAN /
WireGuard paths only.

## Goals

- A second host that can serve `https://headscale.el-jefe.me` to both LAN and
  public clients within minutes of the operator deciding to promote it.
- Database loss on failover bounded to one minute.
- Promote and demote are single commands with verification output.
- The standby is inert until promoted: nothing listens, nothing registers.

## Non-goals

- Automatic failover, health-driven switching, floating addresses.
- Moving headscale to Postgres or any shared database.
- Changing how clients find headscale (hostname, split-horizon, VPS front door
  stay as they are).

## Anti-goals (would make this a failure even if it works)

- Two headscales writing at once. Promote must refuse if dm's headscale still
  answers; demote must refuse until the operator chooses which database wins.
- The standby or its sync depending on the tailnet. All sync traffic is LAN
  (192.168.50.0/24) or wg0 (10.0.0.0/24).
- Breaking the 2026-09-07 lesson: the VPS front door must point at exactly one
  backend at a time (two endpoints = 50 % 504s).

## Current state (verified 2026-10-23)

| Piece | Where | Detail |
|---|---|---|
| headscale | dm, systemd | v0.29.3 (deb), `listen_addr 0.0.0.0:8081`, grpc 50443, metrics `10.0.0.9:9099` |
| State | dm `/var/lib/headscale/` | `db.sqlite` (+wal/shm), `noise_private.key`, `db-backup.sqlite` |
| Policy | database mode | ACLs live in the SQLite DB, no file |
| TLS | dm `/etc/headscale/tls/tls.{crt,key}` | pulled daily from the k8s cert secret by `sync-headscale-cert.{service,timer}` (`/usr/local/sbin/sync-headscale-cert.sh`) |
| LAN front | dm nginx site `headscale-bootstrap` | listens `192.168.50.152:443 ssl` and `:80`, `proxy_pass http://127.0.0.1:8081`; also `10.0.0.9:8443 ssl` |
| Bootstrap | dm `headscale-bootstrap-dnat.service` | iptables DNAT `198.51.100.53:443 -> 10.0.0.9:8443` so dm's own tailscale client reaches its local headscale |
| LAN DNS (1) | BE88U `/jffs/configs/hosts.homearpa` | `192.168.50.152 headscale.el-jefe.me`; `local=/headscale.el-jefe.me/` in `dnsmasq.conf.add` keeps it from forwarding upstream. |
| LAN DNS (2) | AX86U Pro unbound | its own `local-data` A record `headscale.el-jefe.me -> 192.168.50.152`, TTL 60 (`unbound-control list_local_data`); `home.arpa` forwarded to BE88U. |
| LAN DNS (3) | ASUSTOR blocky (.142) | customDNS copy, TTL 3600. **Out of scope** (operator 2026-10-23): no node uses .142 and the router intercepts port 53. |
| Resolvers | nodes | m720q/elitedesk/dm: `192.168.50.1`, then `.103`; m920s/neon: MagicDNS `100.100.100.100` with headscale-pushed upstreams (1.1.1.1 global, `.1/.103` for home.arpa) — the BE88U's DNS interception makes every LAN lookup land on the routers anyway. dm itself pins the name to `198.51.100.53` in `/etc/hosts` (bootstrap). |
| VPS bootstrap | vmi3610371 | `/etc/hosts` pins `headscale.el-jefe.me -> 198.51.100.53`; `headscale-bootstrap-dnat.service` DNATs `198.51.100.53:443 -> 10.0.0.9:8443` (dm). The VPS's own tailscaled depends on this. |
| wg peering | m920s <-> VPS | verified 2026-10-23: VPS has peer AllowedIPs `10.0.0.12/32`, handshakes fresh both ways. Port 8081/8443 reachability on m920s wg0 is a build-time firewall check. |
| Public | edge VPS Traefik → k8s `headscale/headscale` Service | selectorless; Endpoints `10.0.0.9:8081,10.0.0.9:9099`. Headplane (`headscale/headplane`) uses the same Service. |
| Standby host | m920s | bond0 `192.168.50.155`, wg0 `10.0.0.12`, ports 80/443 free (svclb hostPorts exist only on the VPS), UPS-monitored, k3s server (root has `/etc/rancher/k3s/k3s.yaml`). No headscale, no nginx, no SSH keys to dm / routers / VPS yet. |
| Endpoints object | k8s `headscale/headscale` | excluded from ArgoCD, so a kubectl patch is not reverted. |

## Design

### 1. Standby install (one-time)

On m920s:

- Install headscale **0.29.3** from the same .deb as dm (pin the version; the DB
  schema must match). Service `headscale.service` stays **disabled**.
- Install nginx; copy dm's `headscale-bootstrap` site with addresses rewritten
  `192.168.50.152 -> 192.168.50.155`, `10.0.0.9 -> 10.0.0.12`. Service
  **disabled**.
- **No** bootstrap `/etc/hosts` pin and **no** DNAT unit on m920s. Its tailscaled
  resolves the name through LAN DNS, which after promote is m920s's own nginx.
  (A permanent pin would blackhole m920s's tailscaled while it is standby; m920s
  is an etcd/control-plane node.)
- Copy `/etc/headscale/config.yaml` with `metrics_listen_addr` rewritten to
  `10.0.0.12:9099`. Everything else identical (server_url, base_domain, DERP,
  noise, unix socket, database path).
- Install `sync-headscale-cert.sh` + timer exactly as on dm (it reads the cert
  from the k8s secret; m920s has a kubeconfig as root). Enabled: the standby's
  cert is always current without touching dm.
- Create `/var/lib/headscale/` owned by `headscale:headscale`, mode 0700.

### 2. Continuous sync (standby pulls, every minute)

A systemd timer on m920s, `headscale-standby-sync.timer` (OnUnitActiveSec=1min),
runs `/usr/local/sbin/headscale-standby-sync.sh`:

1. `ssh dm sudo sqlite3 /var/lib/headscale/db.sqlite ".backup /var/lib/headscale/standby-export.sqlite"`
   — a consistent snapshot via SQLite's online backup API (safe under WAL while
   headscale is writing).
2. `rsync` that file plus `noise_private.key` from dm into
   `/var/lib/headscale/standby/` on m920s (staging dir, not the live path).
3. `rsync` `/etc/headscale/config.yaml` from dm into
   `/var/lib/headscale/standby/dm-config.yaml` for drift comparison only (the
   standby's own config is hand-managed per §1; the script diffs and logs if
   dm's config changed, it never overwrites).
4. Write `/var/lib/node_exporter/textfile_collector/headscale_standby.prom` with
   `headscale_standby_last_sync_timestamp_seconds` and
   `headscale_standby_sync_ok`.

**Pull, not push:** a dead dm makes the timer fail loudly on m920s; a dead m920s
cannot break dm. The sync must never touch the live `db.sqlite` on m920s.

Access: a dedicated ed25519 key on m920s root, authorized on dm for the
`maxjeffwell` user with `command=` restricted to the rsync/sqlite wrapper
(`/usr/local/sbin/headscale-standby-export.sh`, which runs the two commands
above under sudo with a matching NOPASSWD rule). No interactive shell.

### 3. Promote (`/usr/local/sbin/headscale-promote.sh` on m920s)

Steps, each printed and checked; abort on first failure:

1. **Guard:** `curl -s --max-time 3 http://10.0.0.9:8081/health` and the same on
   `192.168.50.152:443`. If dm's headscale answers, **refuse** unless
   `--force` (operator asserts dm is being taken down). Print the last sync
   timestamp and age; refuse if older than 15 min unless `--force`.
2. Stop and disable `headscale-standby-sync.timer`.
3. Copy `standby/standby-export.sqlite -> db.sqlite` (remove any stale
   `-wal/-shm`), `standby/noise_private.key -> noise_private.key`, chown
   `headscale:headscale`.
4. `systemctl start headscale`; wait for `/health`; `headscale nodes list`
   must show the expected node count (printed, not asserted).
5. `systemctl start nginx`.
6. **LAN DNS, BE88U:** back up `hosts.homearpa` to `hosts.homearpa.bak-<date>`,
   `sed` `192.168.50.152 headscale.el-jefe.me -> 192.168.50.155 ...`,
   `service restart_dnsmasq`. Verify with `dig @192.168.50.1`. Access: dedicated
   key on m920s root, authorized on the BE88U (`/jffs/configs/authorized_keys`,
   Merlin's dropbear). Nothing else on the router is touched.
7. **LAN DNS, AX86U Pro:** `unbound-control local_data_remove
   headscale.el-jefe.me` + `local_data "headscale.el-jefe.me. 60 IN A
   192.168.50.155"`, and the same edit in the persisted unbound conf file so
   it survives an unbound restart (file located at build time; back it up).
   Verify with `dig @192.168.50.103`. Access: dedicated key, port 2222.
8. **VPS bootstrap:** over wg0 to `10.0.0.1`, run the restricted wrapper
   `headscale-bootstrap-target m920s` which rewrites the DNAT rule to
   `10.0.0.12:8443` and the persisted unit's ExecStart/ExecStop so a VPS reboot
   keeps it. Verify from the VPS: `curl --resolve
   headscale.el-jefe.me:443:198.51.100.53 https://headscale.el-jefe.me/health`.
   Access: dedicated key on m920s root, authorized on the VPS with `command=`
   locked to that wrapper (accepts only `dm` | `m920s`). Rationale: during a dm
   outage any tailscaled restart on the VPS (Contabo maintenance, package
   update) would otherwise log the edge out, taking Traefik and every public
   site with it.
9. **Public front door:** `kubectl -n headscale patch endpoints headscale` to
   `10.0.0.12:8081,10.0.0.12:9099` (root's k3s kubeconfig on m920s; the API is
   local). Verify `curl https://headscale.el-jefe.me/health` resolved via the
   public answer (from the VPS) and via `192.168.50.1` and `.103` (LAN).
10. Print a summary: node count, all health checks, what changed, and the
    demote command.

Idempotent: re-running on an already-promoted standby just re-verifies.

### 4. Demote (`/usr/local/sbin/headscale-demote.sh` on m920s)

Hands control back to dm once dm is healthy again.

1. **Guard:** dm must be reachable over SSH and its `headscale.service` must be
   **stopped** (the script checks; it does not stop it for you). Refuse
   otherwise.
2. **Database decision:** compare the standby's live `db.sqlite` mtime/row
   counts with dm's. Default: copy the standby's DB **to dm** (it was the
   writer during the outage). `--keep-dm-db` skips the copy for the case where
   the operator decides dm's copy wins. Either way the other copy is kept as
   `db.sqlite.demoted-<date>`.
3. Stop headscale, nginx, bootstrap-dnat on m920s; disable them.
4. Revert BE88U + AX86U DNS, the VPS DNAT (`headscale-bootstrap-target dm`),
   and the k8s Endpoints to dm's addresses (same mechanics as promote
   §3.6–3.9, reversed).
5. Start headscale, nginx, bootstrap-dnat on dm (via SSH, sudo).
6. Verify both health paths point at dm; re-enable `headscale-standby-sync.timer`.

### 5. Observability

- Prometheus alert `HeadscaleStandbySyncStale`: `time() -
  headscale_standby_last_sync_timestamp_seconds > 900` or `sync_ok == 0`,
  warning, for 10m. Lives with the other rules in this repo.
- Prometheus alert `HeadscaleTwoWriters`: blackbox `/health` probes of
  `http://10.0.0.9:8081` **and** `http://10.0.0.12:8081` both up for 5m,
  critical. This replaces any start-guard on dm (see §7).
- The existing headscale health/Goldpinger checks keep covering the live
  instance; nothing new there.

### 6. Runbook

`docs/runbooks/headscale-cold-standby.md`: when to promote, the exact two
commands, what "refused" messages mean, how to pick a DB on demote, the
manual fallback for each automated step (BE88U line, AX86U unbound, VPS DNAT,
kubectl patch) in case the script itself is unavailable, the note that blocky
(.142) keeps dm's address for up to 1 h, and the **rebuilt-dm procedure**:
provision dm from the §1 recipe with addresses swapped back, then run demote.

### 7. dm coming back while m920s is live

No start-guard on dm. dm is a laptop with its own battery and is rebooted
frequently for updates; a probe-based guard would add a failure mode to every
routine reboot for a case that only exists while m920s is promoted. If dm's
headscale does start during a promotion, the only writes it can receive are
its own node record (its tailscaled is pinned to itself); `HeadscaleTwoWriters`
fires and demote's default (standby DB wins) discards those writes.

## Constraints

- headscale version on m920s must equal dm's at all times; upgrading dm means
  upgrading the standby in the same change (noted in the runbook).
- The sync key on dm and the router key on the BE88U are single-purpose and
  command-restricted. No new interactive access is created.
- No change to dm's running headscale, nginx, or DNAT units beyond the export
  wrapper and sudoers line. No start-guard on dm (§7).
- Nothing in k3s is modified except the `headscale/headscale` Endpoints during
  promote/demote. The Service stays selectorless.

## Decisions already made by the operator

- Host: m920s.
- Failover is manual, one command. Automatic takeover was considered and
  rejected (3-part custom glue, split-brain risk, mild outage profile).
- The BE88U split-horizon edit happens inside the promote script; the AX86U
  copy too. blocky on the ASUSTOR is left alone.
- m920s holds a restricted key to the VPS so promote/demote flip the VPS's own
  bootstrap DNAT.
- No start-guard on dm; `HeadscaleTwoWriters` alert instead.

## Builder's calls (made in this document, open to correction)

- Pull-based sync from the standby, one-minute cadence, SQLite online backup
  rather than file copy or Litestream.
- Standby config is hand-managed and drift-checked, not auto-overwritten.
- Promote refuses on a live dm or stale sync unless `--force`.
- Demote defaults to the standby's database winning.
- Textfile-collector metric + two alerts (sync health, two writers).
- Demote assumes dm's install is intact; a rebuilt dm is re-provisioned from
  the runbook first.
- No bootstrap pin/DNAT on m920s.

## Left to the builder

- Exact sudoers and `command=` wrapper text.
- Where the scripts live in this repo (suggest `scripts/headscale-standby/`)
  and how they get to the hosts (manual copy is acceptable for two hosts).
- Test plan: a rehearsal promote/demote on a quiet evening with the node count
  and both health paths recorded before and after.
