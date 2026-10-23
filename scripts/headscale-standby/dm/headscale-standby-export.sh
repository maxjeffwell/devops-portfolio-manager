#!/bin/bash
# Forced command for the m920s standby key on dm (debian-marmoset).
# Installed at /usr/local/sbin/headscale-standby-export.sh, mode 755.
# authorized_keys: command="/usr/local/sbin/headscale-standby-export.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 ... headscale-standby-dm
#
# Verbs (one word, from SSH_ORIGINAL_COMMAND) are passed to the root-side helper via sudo:
#   export | config | state | info | receive-db | start   (see headscale-standby-dmside.sh)
#   anything else -> refused, exit 64
set -euo pipefail

case "${SSH_ORIGINAL_COMMAND:-}" in
  export|config|state|info|receive-db|start)
    exec sudo -n /usr/local/sbin/headscale-standby-dmside.sh "$SSH_ORIGINAL_COMMAND"
    ;;
  *)
    echo "headscale-standby-export: refused: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2
    exit 64
    ;;
esac
