# headscale cold standby (dm → m920s)

Design: `docs/superpowers/specs/2026-10-23-headscale-cold-standby-m920s-design.md`
Runbook: `docs/runbooks/headscale-cold-standby.md`

Deployment is by hand. Install in this order: dm → m920s → sync → routers → VPS → promote/demote → alerts → runbook.

| File in repo | Host | Path | Mode |
|---|---|---|---|
| `dm/headscale-standby-export.sh` | dm | `/usr/local/sbin/headscale-standby-export.sh` | 755 |
| `dm/sudoers-headscale-standby` | dm | `/etc/sudoers.d/headscale-standby` | 440 |
| `common.sh` | m920s | `/usr/local/lib/headscale-standby/common.sh` | 644 |
| `m920s/config.yaml.sed` | m920s | `/usr/local/lib/headscale-standby/config.yaml.sed` | 644 |
| `m920s/nginx-headscale-bootstrap.conf` | m920s | `/etc/nginx/sites-available/headscale-bootstrap` (+ symlink in `sites-enabled`) | 644 |
| `m920s/headscale-standby-sync.sh` | m920s | `/usr/local/sbin/headscale-standby-sync.sh` | 755 |
| `m920s/headscale-standby-sync.service` / `.timer` | m920s | `/etc/systemd/system/` | 644 |
| `m920s/headscale-standby-status.sh` | m920s | `/usr/local/sbin/headscale-standby-status.sh` | 755 |
| `m920s/headscale-promote.sh` | m920s | `/usr/local/sbin/headscale-promote.sh` | 755 |
| `m920s/headscale-demote.sh` | m920s | `/usr/local/sbin/headscale-demote.sh` | 755 |
| `routers/headscale-dns-target.sh` | BE88U **and** AX86U Pro | `/jffs/scripts/headscale-dns-target.sh` | 755 |
| `vps/headscale-bootstrap-target` | VPS vmi3610371 | `/usr/local/sbin/headscale-bootstrap-target` | 755 |
| `vps/headscale-bootstrap-dnat.service` | VPS | `/etc/systemd/system/headscale-bootstrap-dnat.service` | 644 |
| `vps/headscale-bootstrap.default` | VPS | `/etc/default/headscale-bootstrap` | 644 |

SSH keys live on m920s as root: `/root/.ssh/headscale-standby-{dm,be88u,ax86u,vps}`.
Each remote side authorizes its key with
`command="<wrapper>",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty`.

Versions: headscale on m920s must equal dm (0.29.3, `apt-mark hold` on both). Upgrade both in one change.
