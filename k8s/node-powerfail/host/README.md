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

Timers (2026-09-16): elitedesk 300 s (AVRG900LCD ~20 min), m720q 900 s
(Synology CST135UC ~77 min). dm keeps its own older copy (pwrstatd-* names).
Flow: ONBATT → timer → `upsmon -c fsd` (sudo as nut) → SHUTDOWNCMD cordons,
drains (bounded ~150 s), touches /var/lib/nut-drained.flag, halts → next boot
the oneshot uncordons and clears the flag. LOWBATT remains the backstop.
