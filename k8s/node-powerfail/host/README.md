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
  `https://100.64.0.1:6443`, CA + token from Secret `kube-system/node-powerfail-token`.
- `/etc/nut/upssched.conf`: `AT ONBATT * START-TIMER powerfail <seconds>` /
  `AT ONLINE * CANCEL-TIMER powerfail`, CMDSCRIPT = upssched-cmd.
- `/etc/nut/upsmon.conf`: `SHUTDOWNCMD "/usr/local/sbin/nut-powerfail-shutdown.sh"`,
  `NOTIFYCMD /sbin/upssched`, `NOTIFYFLAG ONBATT SYSLOG+EXEC`, `NOTIFYFLAG ONLINE SYSLOG+EXEC`.
- `systemctl enable k3s-uncordon-onboot.service && systemctl restart nut-monitor`

Timers (2026-09-16): elitedesk 300 s (AVRG900LCD ~20 min, battery-forced),
dm 720 s (ST625U ~63 min; older copy of these scripts with pwrstatd-* names),
m720q 900 s (Synology CST135UC ~77 min). The 3 min dm/m720q offset avoids
PDB eviction races on shared replicas. M920s: 900 s.
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
