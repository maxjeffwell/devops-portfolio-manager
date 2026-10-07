#!/usr/bin/env bash
# Helm post-renderer for the democratic-csi-mp release.
# The node DaemonSet's driver-registrar container mounts the whole kubelet dir
# (/var/lib/kubelet) with no mountPropagation (= private). Every mount under it
# that exists when the container starts -- including other drivers' CSI
# globalmounts (Mayastor) -- is copied into that private namespace and never
# unmounted there, so ext4 keeps the superblock/jbd2 alive and Mayastor's
# NodeUnstage times out ("Timed out waiting for /proc/fs/jbd2/nvmeXn1-8").
# Seen on every m720q/elitedesk drain (9/30, 10/6, 10/7). The busybox
# cleanup container has the same bug via plugins-dir (/var/lib/kubelet/plugins,
# where CSI globalmounts live). HostToContainer (rslave) lets host unmounts
# propagate in. The chart hardcodes both mounts and offers no values toggle
# (checked 0.15.1). python3 + PyYAML only. Manifest arrives on stdin, leaves
# on stdout.
set -euo pipefail
exec python3 -c '
import sys, yaml
FIX = {("driver-registrar", "kubelet-dir"), ("cleanup", "plugins-dir")}
docs = [d for d in yaml.safe_load_all(sys.stdin) if d is not None]
for d in docs:
    if d.get("kind") != "DaemonSet":
        continue
    for c in d["spec"]["template"]["spec"]["containers"]:
        for m in c.get("volumeMounts", []):
            if (c["name"], m["name"]) in FIX:
                m["mountPropagation"] = "HostToContainer"
yaml.safe_dump_all(docs, sys.stdout, default_flow_style=False, sort_keys=False)
'
