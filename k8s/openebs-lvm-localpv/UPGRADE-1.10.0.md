# lvm-localpv 1.8.1 -> 1.10.0 (prepared 2026-08-25)

23 live PVs on `local.csi.openebs.io` (elitedesk, debian-marmoset, both VPSs).
Data path is unaffected: volumes are host LVs already mounted by the kubelet;
only the CSI controller Deployment and node DaemonSet pods restart.

## What changes (from `kubectl diff` of the rendered chart)
- driver `openebs/lvm-driver` 1.8.1 -> 1.10.0
- `csi-resizer` v1.11.2 -> **v2.0.0** (needs k8s >= 1.34 for VolumeAttributesClass; cluster is 1.34.3; RBAC in the chart's ClusterRole updated accordingly)
- `csi-snapshotter` v7.0.0 -> v8.2.0, `csi-provisioner` v5.2.0 -> v6.1.0
- bundled `snapshot-controller` sidecar **removed** (`lvmController.snapshotController.enabled=false`)
- `lvmvolumes` CRD: additive optional `qos` block (cgroup v2 io throttling)
- new `Service openebs-lvm-lvm-localpv-node-service` (metrics)
- All rendered objects (CSIDriver, CRDs, PriorityClasses) are already helm-owned by release `openebs-lvm` -> no adoption issues.

## Behaviour changes worth knowing (1.9.0)
- Scheduler now considers **thin-pool free space**, not just VG free (SpaceWeighted).
  Previously: dm VG free = 0 and vmi3115606 = 1Gi could not take new PVCs regardless of thin-pool headroom.
- Thin-pool capacity reclaimed after the last thin LV is deleted.
- Unmount errors now surface from NodeUnpublishVolume (was silently OK).

## Run
    cd ~/GitHub_Projects/devops-portfolio-manager
    helm upgrade openebs-lvm openebs/lvm-localpv --version 1.10.0 -n openebs -f k8s/openebs-lvm-localpv/values.yaml --timeout 10m

## Verify
    kubectl -n openebs rollout status deploy/openebs-lvm-lvm-localpv-controller
    kubectl -n openebs rollout status ds/openebs-lvm-lvm-localpv-node
    kubectl -n openebs get deploy openebs-lvm-lvm-localpv-controller -o jsonpath='{range .spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}'   # no snapshot-controller
    kubectl get lvmnodes.local.openebs.io -n openebs                                                          # all 4 nodes report VGs
    kubectl get pv -o json | jq '[.items[]|select(.spec.csi.driver=="local.csi.openebs.io")]|length'         # still 23
    # pods on lvm PVCs keep running; then provision+delete a 1Gi test PVC on openebs-lvmpv

## Rollback
    helm -n openebs rollback openebs-lvm 1
