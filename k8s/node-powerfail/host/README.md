# Host-side power-fail files (elitedesk, m720q, M920s)

Installed on each home k3s node (NOT applied by ArgoCD — this directory holds
no YAML). Pair with the ServiceAccount in `../rbac.yaml`.

| File | Destination | Mode |
|---|---|---|
| nut-powerfail-shutdown.sh | /usr/local/sbin/ | 0755 |
| k3s-uncordon-onboot.sh | /usr/local/sbin/ | 0755 |
| upssched-cmd | /usr/local/sbin/ | 0755 |
| k3s-uncordon-onboot.service | /etc/systemd/system/ | 0644 |
| nut-fsd.sudoers | /etc/sudoers.d/nut-fsd | 0440 |

Plus, per node:

- `/etc/kubernetes/node-powerfail.kubeconfig` (root 0600): server
  `https://127.0.0.1:6443` (every node here is a k3s server with a local API since
  2026-09-25; the old `100.64.0.1` VPS target was retired), CA + token from Secret
  `kube-system/node-powerfail-token`.
- `/etc/nut/upssched.conf`: `AT ONBATT * START-TIMER powerfail <seconds>` /
  `AT ONLINE * CANCEL-TIMER powerfail`, CMDSCRIPT = upssched-cmd.
- `/etc/nut/upsmon.conf`: `SHUTDOWNCMD "/usr/local/sbin/nut-powerfail-shutdown.sh"`,
  `NOTIFYCMD /sbin/upssched`, `NOTIFYFLAG ONBATT SYSLOG+EXEC`, `NOTIFYFLAG ONLINE SYSLOG+EXEC`.
- `systemctl enable k3s-uncordon-onboot.service && systemctl restart nut-monitor`

Timers (2026-09-16): elitedesk 300 s (AVRG900LCD ~20 min, battery-forced),
dm 720 s (ST625U ~63 min; older copy of these scripts with pwrstatd-* names),
m720q 900 s (Synology CST135UC ~77 min). The 3 min dm/m720q offset avoids
PDB eviction races on shared replicas. M920s (installed 2026-09-25): 600 s,
secondary of `ASUSTOR-UPS@192.168.50.142` (APC Back-UPS XS 1500M) as user
`maxjeffwell` (ADM-managed upsd.users) — drains while 2 of 3 etcd servers are up.
Flow: ONBATT → timer → `upsmon -c fsd` (sudo as nut) → SHUTDOWNCMD cordons,
drains (bounded ~150 s), touches /var/lib/nut-drained.flag, halts → next boot
the oneshot uncordons and clears the flag. LOWBATT remains the backstop.

## NFS boot gate (installed 2026-09-16 on dm, elitedesk, m720q)

| File | Destination | Mode |
|---|---|---|
| nfs-servers-online.sh | /usr/local/sbin/ | 0755 |
| nfs-servers-online.service | /etc/systemd/system/ | 0644 |
| k3s-agent-after-nfs-gate.conf | /etc/systemd/system/k3s-agent.service.d/ | 0644 |

k3s-agent `Wants=`/`After=` the gate; the gate polls `showmount -e` for
`192.168.50.149:/mnt/backups`, `192.168.50.149:/volume1/channels-data` and `192.168.50.109:/volume1/k8s-nfs` (TCP 2049
fallback if nfs-common is ever absent; m720q got nfs-common 9/16) every 5 s and gives up after
900 s with a `nfs-gate` WARNING in the journal, so a dead NAS delays k3s by at
most 15 min. `RemainAfterExit=yes` ⇒ a plain `systemctl restart k3s-agent`
does not re-run it. Change targets/deadline by editing the script or a
`Environment=DEADLINE=` drop-in. For the future 3-server layout the unit's
`Before=` already covers `k3s.service`.

## elitedesk wake-on-LAN after a short outage (2026-09-16)

elitedesk's UPS (AVRG900LCD) never cuts power by design (BE88U + OMR share
it), so after an outage shorter than its battery elitedesk halts at 5 min and
would stay off. Fix lives on the BE88U (`be88u/`):

- `/jffs/scripts/nut-notify-be88u.sh` = upsmon NOTIFYCMD, writes
  `/tmp/ups-last-onbatt` on ONBATT (`/opt/etc/nut/upsmon.conf`: NOTIFYCMD +
  NOTIFYFLAG ONBATT/ONLINE SYSLOG+EXEC; backup `.bak-20260916-wol`).
- `/jffs/scripts/elitedesk-wol.sh`, cron `*/2` (`cru elitedesk_wol`, persisted
  in `services-start`): if elitedesk answers on neither .116/.115 AND an ONBATT
  marker < 6 h old exists AND `upsc ASUSTOR-UPS@.142` or `cyberpower@.152`
  reports OL (mains back) → `ether-wake -i br0 38:22:e2:19:30:42` (eno1),
  10 min between attempts. A maintenance halt (no ONBATT) is never woken.

elitedesk side: eno1 `Wake-on: g` (persisted via `post-up ethtool -s eno1 wol g`
in /etc/network/interfaces); HP BIOS: Wake On LAN = Boot to Hard Drive, After
Power Loss = Power On, **S5 Maximum Power Savings must be Disable** (needs the
BIOS setup password — `hp-bios-s5-wol.sh` prompts for it via hp-bioscfg).
