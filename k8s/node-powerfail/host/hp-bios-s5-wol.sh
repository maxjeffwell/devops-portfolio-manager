#!/bin/sh
# One-shot: disable "S5 Maximum Power Savings" in the HP BIOS so the onboard
# NIC keeps power in soft-off and Wake-on-LAN works. Prompts for the BIOS
# setup password; nothing is echoed or logged.
A=/sys/class/firmware-attributes/hp-bioscfg
ATTR="$A/attributes/S5 Maximum Power Savings"
echo "current: $(cat "$ATTR/current_value")"
printf "HP BIOS setup password: "; stty -echo; read -r PW; stty echo; echo
printf '%s' "$PW" > "$A/authentication/Setup Password/current_password" || { echo "password write failed"; exit 1; }
echo Disable > "$ATTR/current_value"; rc=$?
printf '' > "$A/authentication/Setup Password/current_password" 2>/dev/null
unset PW
echo "write rc=$rc  now: $(cat "$ATTR/current_value")  pending_reboot=$(cat $A/attributes/pending_reboot)"
