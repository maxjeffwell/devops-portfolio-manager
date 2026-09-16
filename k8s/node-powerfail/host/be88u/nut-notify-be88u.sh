#!/bin/sh
# upsmon NOTIFYCMD on the BE88U. Records the last time the shared UPS went on
# battery so elitedesk-wol.sh can tell a power event from a maintenance halt.
case "$NOTIFYTYPE" in
  ONBATT) date +%s > /tmp/ups-last-onbatt; logger -t nut-notify "ONBATT marker written" ;;
  ONLINE) logger -t nut-notify "UPS back online" ;;
esac
exit 0
