#!/usr/bin/env bash
# Helm post-renderer for the mayastor release.
# Removes the bundled cluster-wide snapshot-controller from the CSI controller
# Deployment. That reconciler (VolumeSnapshot <-> VolumeSnapshotContent) must
# run exactly once per cluster; ours is kube-system/snapshot-controller
# (leader-elected pair). The mayastor chart hardcodes the sidecar with
# --leader-election=false and offers no values toggle (checked through
# umbrella 4.5.1 / mayastor 2.11.1). csi-snapshotter (the per-driver sidecar)
# is kept. python3 + PyYAML only. Manifest arrives on stdin, leaves on stdout.
set -euo pipefail
exec python3 -c '
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if d is not None]
for d in docs:
    if d.get("kind") == "Deployment" and d["metadata"]["name"] == "mayastor-csi-controller":
        cs = d["spec"]["template"]["spec"]["containers"]
        d["spec"]["template"]["spec"]["containers"] = [c for c in cs if c["name"] != "csi-snapshot-controller"]
yaml.safe_dump_all(docs, sys.stdout, default_flow_style=False, sort_keys=False)
'
