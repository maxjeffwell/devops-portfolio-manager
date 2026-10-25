# Host-side network files (m720q)

Installed by hand on the node (NOT applied by ArgoCD — this directory holds
no YAML). m720q uses ifupdown (no NetworkManager / networkd).

| File | Destination | Mode |
|---|---|---|
| m720q/eno1 | /etc/network/interfaces.d/eno1 | 0644 |

## m720q NICs

- `bond0` = active-backup over `enp1s0` + `enp3s0` (igc, 2.5G) → **192.168.50.118** (primary).
- `eno1` = onboard I219 (e1000e, 1G) → **192.168.50.119**, a separate DHCP leg used
  as the rescue link (YazDHCP reservation `m720q-1g`). Same /24 as bond0.

## Why eno1 drops Tailscale UDP (2026-10-24)

Tailscale advertises every local address as a candidate endpoint, and a peer keeps
whichever direct path it found first. marmoset had settled on `.119` (1G, eno1)
instead of `.118` (2.5G, bond0), and replies went out bond0 (asymmetric).

The `post-up` rule drops inbound UDP 41641 on eno1 only, so disco probes to `.119`
fail and every peer falls back to `.118`. SSH and everything else on `.119` still
work. No tailscaled restart needed (a tailscaled restart can wedge flannel — see
the flannel-watchdog).

Apply live without a reboot:

    sudo iptables -C INPUT -i eno1 -p udp --dport 41641 -j DROP 2>/dev/null \
      || sudo iptables -I INPUT -i eno1 -p udp --dport 41641 -j DROP

Verify:

    sudo iptables -L INPUT -v -n | grep 41641          # on m720q
    tailscale status | awk '$2=="m720q"'               # on any peer: direct 192.168.50.118:41641
