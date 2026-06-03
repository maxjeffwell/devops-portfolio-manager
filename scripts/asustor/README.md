# ASUSTOR USB-NIC keep-awake (eth2 / 192.168.50.149)

Pins the USB 2.5GbE NIC's power management on so it stops re-enumerating, so it can
reliably carry dedicated Garage RPC (`rpc_bind_addr = 192.168.50.149:3901`).

Root cause of the resets: NIC shared a USB hub with a 5-bay disk dock (power contention).
The NIC was physically relocated off that hub (port 2-2.3); this hook is defensive +
reboot-persistence. See `docs/superpowers/specs/2026-06-02-asustor-garage-rpc-usb-nic-design.md`.

## Deploy on the NAS (root)
```
install -m0755 usb-nic-keepawake.sh /usr/local/sbin/usb-nic-keepawake.sh   # (busybox: use cat>; install lacks /dev/stdin)
install -m0755 S64usb-nic-keepawake /usr/local/etc/init.d/S64usb-nic-keepawake
```
Runs at boot before S65docker-ce. Reboot-persistence verification is deferred until the
`S97lvm-nfs` loopback-NFS deadlock is cleared (do not reboot the ASUSTOR before then).
