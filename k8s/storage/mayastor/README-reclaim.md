# Reclaim policy: Retain everywhere (2026-09-30)

Every StorageClass we own is `reclaimPolicy: Retain`. Before 2026-09-30 all Mayastor
classes and `openebs-lvmpv-vg0` were `Delete`, which meant deleting a PVC destroyed
the volume immediately: every CNPG replica, the Neon pageservers/safekeepers, the
microservices MongoDB, vaultwarden, garage, channels-dvr and the Mayastor etcd member
sat one `kubectl delete pvc` away from relying on backups.

## Facts

- `reclaimPolicy` is **immutable** on a StorageClass. Changing it = `kubectl delete -f`
  then `kubectl apply -f` the file. PVs reference the class by name only, so existing
  volumes are unaffected by the recreation; the only cost is that a PVC created in the
  few-second gap fails to bind until the class is back.
- The class only sets the policy for **future** PVs. Existing PVs carry their own
  `spec.persistentVolumeReclaimPolicy`; all 29 live `Delete` PVs were patched to
  `Retain` on 2026-09-30.
- `mayastor-single-replica` is rendered by the openebs umbrella chart (release
  `mayastor`) with no reclaim knob, so it stays `Delete`. Its single PV
  (monitoring/crowdsec-lapi-data) was patched to Retain. Prefer
  `mayastor-single-replica-thin` (ours, Retain) for new single-replica volumes.
- This directory and `k8s/openebs-lvm-localpv/storageclasses.yaml` are applied **by
  hand** (`kubectl diff -f` first, then `kubectl apply -f`); no ArgoCD app covers them.

## What Retain changes operationally

Deleting a PVC now leaves the PV in `Released`. To actually free space:

- Mayastor: `kubectl delete pv <name>` removes the Mayastor volume (the CSI driver
  handles it on PV deletion).
- lvm-localpv: `kubectl delete pv <name>` does **not** free the LV; also delete the
  `lvmvolume` CR in namespace `openebs`, or let the snapshot janitor / a manual
  `lvremove` do it. See memory note on the immich ml-cache move (2026-09-30).

To reuse a Released PV, clear `spec.claimRef` and bind a new PVC to it.
