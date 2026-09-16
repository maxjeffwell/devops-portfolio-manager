#!/bin/sh
# BE88U cron (every 2 min): wake elitedesk after a UPS-triggered halt once
# mains is back. elitedesk's own UPS (AVRG900LCD) deliberately never cuts
# power (router + OMR share it), so after an outage SHORTER than its battery
# elitedesk halts at 5 min and would stay off forever. This closes that gap.
#
# Fires only when ALL of:
#   1. elitedesk answers on neither LAN address
#   2. this router's upsmon saw the shared UPS go ON BATTERY within the last
#      MARKER_MAX seconds (marker written by nut-notify-be88u.sh) - so a
#      deliberate maintenance shutdown is never "fixed"
#   3. mains is back: another UPS server in the house reports OL
#   4. at least RATE seconds since the last wake attempt
MAC=38:22:e2:19:30:42          # elitedesk eno1 (I219, WoL g)
IPS="192.168.50.116 192.168.50.115"
MARKER=/tmp/ups-last-onbatt
MARKER_MAX=21600               # 6 h
STATE=/tmp/elitedesk-wol.last
RATE=600                       # 10 min between attempts
UPSC=/opt/bin/upsc
NOW=$(date +%s)

for ip in $IPS; do
  ping -c 1 -W 2 "$ip" >/dev/null 2>&1 && exit 0
done

[ -f "$MARKER" ] || exit 0
[ $((NOW - $(cat "$MARKER"))) -le "$MARKER_MAX" ] || exit 0

mains=0
for u in ASUSTOR-UPS@192.168.50.142 cyberpower@192.168.50.152; do
  st=$($UPSC "$u" ups.status 2>/dev/null)
  case " $st " in *" OL"*|*"OL "*|"OL") mains=1; break;; esac
done
[ "$mains" = 1 ] || exit 0

if [ -f "$STATE" ] && [ $((NOW - $(cat "$STATE"))) -lt "$RATE" ]; then exit 0; fi

echo "$NOW" > "$STATE"
logger -t elitedesk-wol "elitedesk down after UPS event, mains back - sending WoL to $MAC"
/usr/sbin/ether-wake -i br0 "$MAC"
/usr/sbin/ether-wake -i br0 -b "$MAC"
exit 0
