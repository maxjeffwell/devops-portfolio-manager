#!/bin/bash
# Regression tests for the 2026-10-23 review findings (C1-C3, I1-I7). Run from a LAN host with ssh to m920s.
# Each check prints PASS/FAIL; exit 1 if any FAIL. Nothing here changes state on any host.
set -uo pipefail
fail=0
t() { if "$@" >/dev/null 2>&1; then echo "PASS $NAME"; else echo "FAIL $NAME"; fail=1; fi; }
M() { ssh -o BatchMode=yes -o ConnectTimeout=5 m920s "sudo -n bash -c 'source /usr/local/lib/headscale-standby/common.sh; $*'"; }

NAME="C1 dm_live_lan reaches dm nginx by hostname+resolve"
t M 'dm_live_lan'
NAME="C1 dm_live_wg still works"
t M 'dm_live_wg'

NAME="C2 install_snapshot_needed is false while headscale active"
t M 'hs_active() { return 0; }; ! install_snapshot_needed'
NAME="C2 install_snapshot refuses while headscale active"
t M 'hs_active() { return 0; }; ! install_snapshot 2>/dev/null'
NAME="C2 install_snapshot_needed is true when inactive and no live db"
t M 'hs_active() { return 1; }; STATE=$(mktemp -d); install_snapshot_needed'

NAME="C3 health timer exists and is enabled"
t ssh m920s 'systemctl is-enabled headscale-standby-health.timer | grep -qx enabled'
NAME="C3 health metrics file has both targets"
t ssh m920s 'grep -c "^headscale_standby_health_up{target=" /var/lib/node_exporter/textfile_collector/headscale_standby_health.prom | grep -qx 2'
NAME="C3 sync metrics file no longer carries health_up (no duplicate series)"
t ssh m920s '! grep -q headscale_standby_health_up /var/lib/node_exporter/textfile_collector/headscale_standby.prom'
NAME="C3 SyncStale alert is suppressed while m920s is live"
t grep -q 'unless on() headscale_standby_health_up{target="m920s"} == 1' /home/maxjeffwell/GitHub_Projects/devops-portfolio-manager/k8s/headscale/prometheusrule.yaml

NAME="I1 snapshot guards skipped once promoted (headscale active)"
t M 'hs_active() { return 0; }; ! promote_snapshot_guards_apply'
NAME="I1 snapshot guards apply when inert"
t M 'hs_active() { return 1; }; STATE=$(mktemp -d); promote_snapshot_guards_apply'

NAME="I2/I3/I5 vps status has 4 fields: host ip rule-yes dnat-http-code"
t bash -c '[ "$(ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-vps maxjeffwell@10.0.0.1 status" | awk "{print NF}")" = 4 ]'
NAME="I2 vps status reports exactly one bootstrap DNAT rule"
t bash -c 'ssh vmi3610371 "sudo -n iptables -t nat -S OUTPUT | grep -c 198.51.100.53" | grep -qx 1'
NAME="I5 vps bootstrap path answers 200 end to end"
t bash -c '[ "$(ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-vps maxjeffwell@10.0.0.1 status" | awk "{print \$4}")" = 200 ]'
NAME="I3 get_pointer vps is empty unless the rule is present"
t M 'ssh_vps() { echo "vps 10.0.0.9 no 000"; }; [ -z "$(get_pointer vps)" ]'

NAME="I4 demote_db_copy_done is false while headscale active even with marker"
t M 'hs_active() { return 0; }; STATE=$(mktemp -d); touch $STATE/.db-sent-to-dm; ! demote_db_copy_done'

NAME="I6 ax86u status reports tools ok (unbound-control reachable under forced command)"
t bash -c '[ "$(ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-ax86u -p 2222 maxjeffwell@192.168.50.103 status" | awk "{print \$3}")" = ok ]'
NAME="I6 be88u status reports tools ok"
t bash -c '[ "$(ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-be88u -p 2222 maxjeffwell@192.168.50.1 status" | awk "{print \$3}")" = ok ]'

NAME="routers: fix-authkeys.sh normaliser keeps the forced-command line (be88u)"
t bash -c 'ssh 192.168.50.1 /jffs/scripts/fix-authkeys.sh && [ "$(ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-be88u -p 2222 maxjeffwell@192.168.50.1 status")" = "be88u 192.168.50.152 ok" ]'
NAME="routers: fix-authkeys.sh normaliser keeps the forced-command line (ax86u)"
t bash -c 'ssh -p 2222 maxjeffwell@192.168.50.103 /jffs/scripts/fix-authkeys.sh && [ "$(ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-ax86u -p 2222 maxjeffwell@192.168.50.103 status")" = "ax86u 192.168.50.152 ok" ]'
NAME="routers: no bare copy of a restricted key in authorized_keys"
t bash -c '[ "$(ssh 192.168.50.1 "grep -c \"^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMAtBECYBIf5SN38\" /root/.ssh/authorized_keys")" = 0 ] && [ "$(ssh -p 2222 maxjeffwell@192.168.50.103 "grep -c \"^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVHWGv6WfBxqNNYwVQgRye\" /root/.ssh/authorized_keys")" = 0 ]'

NAME="I7 dm info verb reports node count"
t bash -c 'ssh m920s "sudo -n ssh -o BatchMode=yes -i /root/.ssh/headscale-standby-dm maxjeffwell@192.168.50.152 info" | grep -qE "^nodes=[0-9]+ "'

NAME="still inert: m920s headscale/nginx inactive, pointers at dm"
t bash -c '[ "$(ssh m920s "sudo -n headscale-standby-status.sh" | grep -E "^(m920s-health|be88u|ax86u|vps|endpoints) " | awk "{print \$2}" | tr "\n" " ")" = "down 192.168.50.152 192.168.50.152 10.0.0.9 10.0.0.9 " ]'

exit $fail
