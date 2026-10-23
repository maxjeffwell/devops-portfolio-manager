# Runbook: headscale cold standby (dm → m920s)

Design: `docs/superpowers/specs/2026-10-23-headscale-cold-standby-m920s-design.md`
Files: `scripts/headscale-standby/` (README has the file → host map)

headscale normally runs natively on **dm** (debian-marmoset, `192.168.50.152` / wg0 `10.0.0.9`).
**m920s** (`192.168.50.155` / wg0 `10.0.0.12`) holds an inert copy: same headscale 0.29.3, same
config with its own addresses, same nginx site, a minute-fresh SQLite snapshot in
`/var/lib/headscale/standby/`. Nothing on m920s listens until you promote it.

All commands below run **as root on m920s** unless stated.

## Quick status

```
headscale-standby-status.sh
```
```
dm-health up          # dm's headscale answers /health
m920s-health down     # standby is inert
be88u 192.168.50.152  # BE88U hosts.homearpa record (wrapper status: "be88u <ip> ok|missing" — tools check)
ax86u 192.168.50.152  # AX86U unbound local-data (same)
vps 10.0.0.9          # VPS bootstrap DNAT target; wrapper status is "vps <ip> yes|no <http>": yes = exactly one DNAT rule,
                      #   http = /health through the bootstrap IP end to end (DNAT + wg0 + backend nginx). Empty here = rule missing.
endpoints 10.0.0.9    # k8s headscale/headscale Endpoints (public front door via Traefik)
sync-age 24           # seconds since the last snapshot pull
timer enabled
```

## When to promote

Promote when **dm is down or unreachable and you need the control plane**: new nodes joining,
re-auth, ACL or DNS changes. Existing sessions keep working without headscale (node keys never
expire, DERP is public), so a planned dm reboot or a short outage does **not** need a promote.

## Promote

```
headscale-promote.sh            # refuses if dm still answers or the snapshot is > 15 min old
headscale-promote.sh --force    # you are taking dm down deliberately, or accept a stale snapshot
headscale-promote.sh --dry-run --force   # show the steps, change nothing
```

What it does, in order (each step is idempotent; a re-run skips done steps as `already:`):
1. guard (dm health, snapshot age)
2. disable the sync timer
3. install the snapshot + noise key as the live DB
4. start headscale (waits for `/health`), print node count
5. start nginx
6. BE88U hosts entry → `192.168.50.155`
7. AX86U unbound record → `192.168.50.155`
8. VPS bootstrap DNAT → `10.0.0.12:8443` (keeps the edge's own tailscaled alive)
9. k8s Endpoints → `10.0.0.12`
10. verify: both LAN resolvers, LAN https, wg0 http, VPS, Endpoints

Exit 0 done, **2 refused** (message says why), **1 a step failed** (re-run after fixing).

Re-running on an already-promoted m920s is safe: the snapshot-age guard is skipped once a live DB
exists, the "install snapshot" step is skipped while headscale is active (it never replaces an
open database), and every pointer step prints `already:`. Verify also checks the public path via
the edge VPS address and the VPS's own bootstrap path.

`refused:` messages:
- `dm headscale answers` — dm is live; you probably don't need to promote. `--force` if you do.
- `last sync Ns ago` — snapshot older than 15 min; registrations since then would be lost. `--force` to accept.
- `no snapshot` — the sync never ran; check `systemctl status headscale-standby-sync.service`.

## Demote (hand back to dm)

Preconditions: dm is up and **its headscale is stopped** — the script never stops it for you:
```
ssh debian-marmoset sudo systemctl stop headscale
```
Then on m920s:
```
headscale-demote.sh               # standby DB → dm (default: m920s was the writer during the outage)
headscale-demote.sh --keep-dm-db  # dm's DB wins; m920s's DB is kept as db.sqlite.demoted-<ts>
```
Which DB wins: keep dm's only if m920s served **no** registrations or changes while promoted.
Check with `headscale nodes list` on m920s (last-seen column) before deciding. Either way the
loser is kept as `db.sqlite.demoted-<ts>` on the host that lost.

Before copying, demote prints both databases (`nodes=`, `last_seen=`, `mtime=`) so the choice is
visible; it warns if m920s's headscale is not live (its DB may be an unserved snapshot).

Order: copy DB → stop headscale+nginx on m920s → retire m920s DB → BE88U, AX86U, VPS, Endpoints
back to dm → start headscale/nginx/DNAT on dm (over the standby key) → re-enable the sync timer → verify.

## Manual fallbacks (if a script step or the script itself is unavailable)

| Pointer | Set to m920s | Set to dm |
|---|---|---|
| BE88U | `ssh -p 2222 192.168.50.1 /jffs/scripts/headscale-dns-target.sh m920s` | `... dm` |
| AX86U | `ssh -p 2222 192.168.50.103 /jffs/scripts/headscale-dns-target.sh m920s` | `... dm` |
| VPS | `ssh vmi3610371 /usr/local/sbin/headscale-bootstrap-target m920s` | `... dm` |
| Endpoints | `kubectl -n headscale patch endpoints headscale --type=json -p '[{"op":"replace","path":"/subsets/0/addresses/0/ip","value":"10.0.0.12"}]'` | value `10.0.0.9` |

Raw edits behind the wrappers: BE88U `/jffs/configs/hosts.homearpa` line `<ip> headscale.el-jefe.me`
then `service restart_dnsmasq`; AX86U `/opt/share/unbound/configs/unbound.conf.add`
`local-data: "headscale.el-jefe.me. 60 IN A <ip>"` then `unbound-control local_data_remove
headscale.el-jefe.me; unbound-control local_data "headscale.el-jefe.me. 60 IN A <ip>"`; VPS
`/etc/default/headscale-bootstrap` `TARGET_IP=<wg ip>` then `systemctl restart headscale-bootstrap-dnat`.

## Rebuilt dm

If dm was rebuilt rather than just down, provision it **before** demote, from
`scripts/headscale-standby/m920s/` with the addresses swapped back (`192.168.50.152`, `10.0.0.9`):
headscale 0.29.3 (held), `/etc/headscale/config.yaml` (metrics `10.0.0.9:9099`), nginx site,
`sync-headscale-cert` script+timer, `/etc/hosts` pin `198.51.100.53 headscale.el-jefe.me`,
`headscale-bootstrap-dnat.service` (DNAT → `10.0.0.9:8443`), the dm-side helper + wrapper +
sudoers from `scripts/headscale-standby/dm/`, and the m920s key in `authorized_keys`.
Copy the noise key by hand first (`demote` moves only the DB): on m920s
`/var/lib/headscale/noise_private.key` → dm `/var/lib/headscale/noise_private.key` (0600, headscale:headscale).
Then run `headscale-demote.sh`.

## Known limits

- **blocky on the ASUSTOR (`192.168.50.142`)** still answers dm's address for up to 1 h after a
  promote. No node uses it and the router intercepts port 53, so this is accepted.
- **dm's own tailscaled** is pinned to itself (`/etc/hosts` → `198.51.100.53` → its local nginx).
  While promoted, dm cannot re-auth or receive changes. Sessions survive.
- **No start-guard on dm.** If dm boots while m920s is promoted, dm's headscale starts and serves
  only dm's own tailscaled; `HeadscaleTwoWriters` fires. Stop it and demote.
- **Versions must match.** `apt-mark hold headscale` on both. Upgrade dm and m920s in one change.
- Demote assumes dm's install is intact (see Rebuilt dm).

## Alerts

| Alert | Meaning | Do |
|---|---|---|
| `HeadscaleStandbySyncStale` (warning, 10 m) | no snapshot in 15 min or last sync failed | `systemctl status headscale-standby-sync.service` on m920s; test the key: `ssh -i /root/.ssh/headscale-standby-dm maxjeffwell@192.168.50.152 state` |
| `HeadscaleTwoWriters` (critical, 5 m) | dm and m920s both answer `/health` | stop headscale on dm, run `headscale-demote.sh` |

Metrics (node-exporter textfile on m920s): `headscale_standby_last_sync_timestamp_seconds` and
`headscale_standby_sync_ok` from the sync timer (off while promoted; SyncStale is suppressed then),
`headscale_standby_health_up{target="dm"|"m920s"}` from `headscale-standby-health.timer`, which
runs in both states and is what makes `HeadscaleTwoWriters` able to fire.

**Router keys and `fix-authkeys.sh`:** both routers run a cron normaliser on `sshd_authkeys`. The
2026-10-23 version keeps `command="..."` prefixes; if it is ever restored from an older backup the
forced command is stripped within 15 min and the key becomes a full shell — `tests/review-fixes.sh`
checks for exactly that.

## Rehearsal log

| Date | Nodes before | Promote | Demote | Nodes after | Notes |
|---|---|---|---|---|---|
| _pending_ | | | | | first rehearsal not yet run |
