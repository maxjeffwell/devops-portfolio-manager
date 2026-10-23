#!/bin/sh
# fix-authkeys.sh — normalize /root/.ssh/authorized_keys to ONE key per line + dedupe,
# and keep nvram sshd_authkeys in sync. Idempotent (only rewrites when mangled).
#
# Why: the wireless_report addon's "inject" (services-start) rebuilds sshd_authkeys by
# concatenating keys, collapsing them onto ~2 lines. dropbear only authenticates a key
# that BEGINS a line, so personal keys jammed mid-line are silently rejected. This runs
# right after inject (and on a safety cron) to re-separate them. Preserves ALL keys,
# including wireless_report's inter-router keys. Installed 2026-05-30.
#
# 2026-10-23: also preserves OPTION-PREFIXED keys (forced commands such as
#   command="/jffs/scripts/headscale-dns-target.sh",no-port-forwarding,... ssh-ed25519 <blob> <comment>)
# verbatim, and drops any BARE copy of the same key blob so the restriction cannot be bypassed.
# Same file on the BE88U and the AX86U Pro (repo: scripts/headscale-standby/routers/fix-authkeys.sh).

AK=/root/.ssh/authorized_keys
TMP=/tmp/ak_norm.$$
OPT=/tmp/ak_opt.$$

RAW=$(nvram get sshd_authkeys | tr '\n' ' ')
KEYRE='(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-[a-z0-9-]+) [A-Za-z0-9+/=]+ [^ ]+'

# 1. option-prefixed keys, kept verbatim (one per line)
printf '%s ' "$RAW" | grep -oE "command=\"[^\"]*\"(,[a-zA-Z0-9-]+)* $KEYRE" | sort -u > "$OPT"

# 2. everything else: split before every key token, keep valid key lines, squeeze, trim, dedupe
printf '%s ' "$RAW" \
  | sed -r "s/command=\"[^\"]*\"(,[a-zA-Z0-9-]+)* $KEYRE//g" \
  | sed 's/ssh-rsa /\nssh-rsa /g; s/ssh-ed25519 /\nssh-ed25519 /g; s/ssh-dss /\nssh-dss /g; s/ecdsa-/\necdsa-/g' \
  | grep -E '^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-) ' \
  | sed 's/  */ /g; s/ *$//' | sort -u > "$TMP"

# 3. a bare copy of a key that also appears with options would bypass the restriction: drop it
if [ -s "$OPT" ]; then
  awk 'NR==FNR { blob[$3]=1; next } !($2 in blob)' "$OPT" "$TMP" > "$TMP.plain" && mv "$TMP.plain" "$TMP"
  cat "$OPT" >> "$TMP"
fi
rm -f "$OPT"

# Safety: refuse to act if reconstruction yielded nothing (don't wipe a working file)
if [ ! -s "$TMP" ]; then rm -f "$TMP"; exit 0; fi

if ! cmp -s "$TMP" "$AK" 2>/dev/null; then
    mkdir -p /root/.ssh; chmod 700 /root/.ssh /tmp/home/root 2>/dev/null
    cp "$TMP" "$AK"; chmod 600 "$AK"
    nvram set sshd_authkeys="$(cat "$TMP")"; nvram commit
    logger -t fix-authkeys "normalized authorized_keys -> $(grep -c . "$TMP") one-per-line keys (deduped, options preserved)"
fi
rm -f "$TMP"
