#!/bin/sh
# Pin the r8152 USB 2.5GbE NIC (eth2/.149) USB-device power active (defeat autosuspend),
# so it stops re-enumerating under power contention. Resolves the power node dynamically
# from the interface, so it survives USB-port changes. Idempotent.
# Deploy target on the NAS: /usr/local/sbin/usb-nic-keepawake.sh (root, 0755).
IFACE=eth2
DEV=$(readlink -f "/sys/class/net/$IFACE/device" 2>/dev/null)
USB_DEV="$(dirname "$DEV")/power"
[ -w "$USB_DEV/control" ] && echo on > "$USB_DEV/control"
[ -w "$USB_DEV/autosuspend_delay_ms" ] && echo -1 > "$USB_DEV/autosuspend_delay_ms"
logger -t usb-nic-keepawake "$IFACE control=$(cat "$USB_DEV/control" 2>/dev/null)"
