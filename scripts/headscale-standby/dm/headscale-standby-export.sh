#!/bin/bash
# Forced command for the m920s standby key on dm (debian-marmoset).
# Installed at /usr/local/sbin/headscale-standby-export.sh, mode 755.
# authorized_keys: command="/usr/local/sbin/headscale-standby-export.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 ... headscale-standby-dm
#
#   export  -> tar stream on stdout: db.sqlite (fresh SQLite online-backup snapshot) + noise_private.key
#   config  -> /etc/headscale/config.yaml on stdout
#   *       -> refused, exit 64
set -euo pipefail

STATE=/var/lib/headscale
EXPORT=standby-export.sqlite

case "${SSH_ORIGINAL_COMMAND:-}" in
  export)
    sudo -n /usr/bin/sqlite3 "$STATE/db.sqlite" ".backup $STATE/$EXPORT"
    sudo -n /usr/bin/tar -C "$STATE" -c --transform="s/^$EXPORT\$/db.sqlite/" "$EXPORT" noise_private.key
    ;;
  config)
    sudo -n /usr/bin/cat /etc/headscale/config.yaml
    ;;
  *)
    echo "headscale-standby-export: refused: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2
    exit 64
    ;;
esac
