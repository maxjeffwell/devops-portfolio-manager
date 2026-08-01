# csi-driver-smb Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamically-provisioning SMB StorageClass (`smb-asustor`) to the k3s cluster, backed by a new `k8s-smb` share on the ASUSTOR AS5402T, installed and managed via ArgoCD.

**Architecture:** Upstream `csi-driver-smb` Helm chart v1.20.3 installed into `kube-system` by one ArgoCD Application; a second ArgoCD Application syncs an ExternalSecret (Doppler → `smbcreds`) and the StorageClass from this repo. The StorageClass addresses the NAS by DNS name (`asustor-smb.home.arpa`) resolved via the existing `coredns-custom` `home.arpa` zone, so the target stays repointable despite `source` being immutable per-PV.

**Tech Stack:** k3s v1.34.3, ArgoCD (app-of-apps), Helm, external-secrets + Doppler `ClusterSecretStore`, CoreDNS + node-local-dns, Samba 4.x on ASUSTOR ADM.

**Spec:** `docs/superpowers/specs/2026-08-01-csi-driver-smb-design.md`

## Global Constraints

- **Chart:** `csi-driver-smb` version **v1.20.3** from `https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts`.
- **Driver namespace:** `kube-system`. Do **not** create a new namespace; all Applications use `CreateNamespace=false`.
- **StorageClass name:** `smb-asustor`. **Provisioner:** `smb.csi.k8s.io`.
- **Source:** `//asustor-smb.home.arpa/k8s-smb` — DNS name, never a literal IP.
- **Secret name:** `smbcreds` in namespace `kube-system`, keys exactly `username` and `password`.
- **Reclaim policy:** `Retain` on every PV, matching all other StorageClasses in this cluster except Mayastor.
- **NEVER commit credentials to this repository.** It is a public GitHub repo. The SMB password lives only in Doppler. Plan steps reference it by variable, never by value.
- **Repo conventions:** ArgoCD Applications live in `gitops/applications/<name>.yaml`; chart value overrides in `helm-charts/<name>/values-override.yaml`; storage-driver manifests in `k8s/storage/<driver>/`.
- **Commit style:** conventional commits, no attribution trailers. Commit directly to `main`.
- **Chart defaults verified correct for this cluster — do NOT override these:** `linux.tolerations: [{operator: Exists}]` (needed for marmoset's `workload=gpu:NoSchedule` taint), `linux.kubelet: /var/lib/kubelet` (k3s here uses the standard path; `/var/lib/rancher/k3s/agent/kubelet` does not exist), `feature.enableGetVolumeStats: true` (already default), `linux.dnsPolicy: ClusterFirstWithHostNet` (required for the DNS-name source to resolve).

---

### Task 1: ASUSTOR share and Doppler credential

Prerequisites that live outside the cluster. Nothing in later tasks can be verified until this is done, because provisioning against a nonexistent share fails with `NT_STATUS_BAD_NETWORK_NAME`.

**Files:**
- None in this repo. ADM GUI + Doppler only.

**Interfaces:**
- Consumes: nothing.
- Produces: SMB share `k8s-smb` at `/volume1/k8s-smb` on the ASUSTOR, writable by `maxjeffwell`; Doppler keys `ASUSTOR_SMB_USERNAME` and `ASUSTOR_SMB_PASSWORD` in project `portfolio`, config `prd`.

- [ ] **Step 1: Confirm the share does not already exist**

```bash
ssh Asustor 'ls -d "/volume1/k8s-smb" 2>&1; grep -c "^\[k8s-smb\]" /usr/builtin/etc/samba/smb.conf'
```

Expected: `No such file or directory` and `0`. If it already exists, stop and inspect before continuing — do not reuse an unknown directory as a provisioning root.

- [ ] **Step 2: Create the share in the ADM GUI**

Open `https://192.168.50.149:7571` (ADM; HTTP is 6565). Access Control → Shared Folders → Create.

- Name: `k8s-smb`
- Volume: **Volume 1** (the 3.6T HDD volume — not Volume 2, which holds the iSCSI LUN store)
- Description: `csi-driver-smb dynamic provisioning root`
- Do **not** enable the Recycle Bin (PV deletion should not silently retain data on a Retain-policy class).

Then Access Rights: grant `maxjeffwell` **Read & Write**. Leave every other user at No Access.

GUI is used deliberately here rather than editing `smb.conf` — ADM regenerates that file, so hand-edits to share definitions do not survive.

- [ ] **Step 3: Verify the share is exported and writable**

```bash
ssh Asustor 'grep -A3 "^\[k8s-smb\]" /usr/builtin/etc/samba/smb.conf'
```

Expected: a stanza with `path = /volume1/k8s-smb`.

Then verify from a cluster node, exercising the real protocol path:

```bash
sudo mkdir -p /mnt/smbtest
sudo mount -t cifs //192.168.50.149/k8s-smb /mnt/smbtest \
  -o username=maxjeffwell,vers=3.1.1,noserverino
sudo touch /mnt/smbtest/hello && ls -la /mnt/smbtest/
sudo rm /mnt/smbtest/hello
sudo umount /mnt/smbtest && sudo rmdir /mnt/smbtest
```

Expected: mounts without prompting for anything but the password, file creates and deletes cleanly.

If this fails with `NT_STATUS_LOGON_FAILURE`, the tdbsam entry is stale — fix with `ssh Asustor_Root 'smbpasswd -a maxjeffwell'` and retry.

**Do not leave this mount in place.** A NAS-adjacent host holding a stale CIFS mount is the same hazard class as the loopback NFS deadlock.

- [ ] **Step 4: Add the credential to Doppler**

```bash
doppler secrets set ASUSTOR_SMB_USERNAME=maxjeffwell --project portfolio --config prd
doppler secrets set ASUSTOR_SMB_PASSWORD --project portfolio --config prd
```

The second command with no `=value` reads the secret from stdin so the password never lands in shell history. Paste the existing `maxjeffwell` SMB password (the same one used on both NAS boxes and `debian-marmoset`), then Ctrl-D.

- [ ] **Step 5: Verify the keys are readable**

```bash
doppler secrets get ASUSTOR_SMB_USERNAME --project portfolio --config prd --plain
```

Expected: `maxjeffwell`. Do not print the password.

- [ ] **Step 6: No commit**

This task changes nothing in the repo. Proceed to Task 2.

---

### Task 2: CoreDNS record for `asustor-smb.home.arpa`

Adds the name the StorageClass will use, and repairs a pre-existing stale record found during design.

**Files:**
- Modify: `/home/maxjeffwell/GitHub_Projects/portfolio-orchestration-platform/k8s/configmaps/coredns-custom.yaml` (**different repo** — the sibling `portfolio-orchestration-platform`)

**Interfaces:**
- Consumes: nothing.
- Produces: `asustor-smb.home.arpa` → `192.168.50.149`, resolvable from any pod. Task 4's StorageClass depends on this name existing.

- [ ] **Step 1: Capture the live ConfigMap before touching anything**

```bash
kubectl -n kube-system get cm coredns-custom -o yaml > /tmp/coredns-custom.live.yaml
kubectl -n kube-system get cm coredns-custom -o jsonpath='{.data.home-arpa\.server}'
```

Expected live content:

```
home.arpa:53 {
  errors
  cache 30
  hosts {
    10.0.0.1 backrest.home.arpa
    fallthrough
  }
}
```

This is the drift the spec warns about: the `home-arpa.server` key exists **only** in the cluster. The tracked git file has just `disable-ipv6.override` and `doppler-proxy.override`. Applying the git file unmodified would delete this zone.

- [ ] **Step 2: Verify the current (broken) resolution, so the fix is provably a fix**

```bash
kubectl run -it --rm dnstest --image=busybox:1.36 --restart=Never -- \
  nslookup backrest.home.arpa
```

Expected: resolves to `10.0.0.1` — an address on the retired WireGuard overlay that no longer answers. This is the bug being fixed.

- [ ] **Step 3: Add the `home-arpa.server` key to the tracked file**

In `portfolio-orchestration-platform/k8s/configmaps/coredns-custom.yaml`, append to the `data:` block, after `doppler-proxy.override`:

```yaml
  home-arpa.server: |
    home.arpa:53 {
      errors
      cache 30
      hosts {
        192.168.50.149 asustor-smb.home.arpa
        100.64.0.1 backrest.home.arpa
        100.64.0.2 backrest.home.arpa
        fallthrough
      }
    }
```

`asustor-smb.home.arpa` is the SMB source for Task 4. The two `backrest` records replace the dead `10.0.0.1`: `backrest.home.arpa` is an Ingress host, and traefik's LoadBalancer addresses are `100.64.0.1,100.64.0.2`. The `hosts` plugin returns both.

Also update the file's header comment block, which documents each key. Add after the `doppler-proxy.override:` paragraph:

```
# home-arpa.server:
#   Serves the internal home.arpa zone.
#   asustor-smb.home.arpa -> ASUSTOR eth2 (5G), the source for the smb-asustor
#   StorageClass. Addressed by name because csi-driver-smb bakes `source` into
#   each PV immutably; repointing to .142/.133 must not require PV rebuilds.
#   backrest.home.arpa -> traefik LoadBalancer IPs (Ingress host, not a backend).
```

- [ ] **Step 4: Diff the rendered file against the live ConfigMap before applying**

```bash
cd /home/maxjeffwell/GitHub_Projects/portfolio-orchestration-platform
kubectl diff -f k8s/configmaps/coredns-custom.yaml
```

Expected: the **only** differences are the three hosts lines (one added `asustor-smb`, `10.0.0.1 backrest` replaced by two `100.64.0.x backrest`) plus comment text. If `disable-ipv6.override` or `doppler-proxy.override` show as changed or removed, **stop** — the git file has drifted further than expected and applying it would break DNS for the whole cluster.

- [ ] **Step 5: Apply and restart CoreDNS**

```bash
kubectl apply -f k8s/configmaps/coredns-custom.yaml
kubectl rollout restart deployment coredns -n kube-system
kubectl rollout status deployment coredns -n kube-system --timeout=120s
```

CoreDNS must restart because k3s imports these files into the Corefile at startup.

- [ ] **Step 6: Verify both names resolve correctly**

```bash
kubectl run -it --rm dnstest --image=busybox:1.36 --restart=Never -- \
  sh -c 'nslookup asustor-smb.home.arpa; nslookup backrest.home.arpa'
```

Expected: `asustor-smb.home.arpa` → `192.168.50.149`; `backrest.home.arpa` → `100.64.0.1` and `100.64.0.2`, no `10.0.0.1`.

- [ ] **Step 7: Confirm no collateral DNS damage**

```bash
kubectl run -it --rm dnstest --image=busybox:1.36 --restart=Never -- \
  nslookup kubernetes.default.svc.cluster.local
```

Expected: resolves to the cluster API service IP. This proves the Corefile still parses and normal service discovery is intact.

- [ ] **Step 8: Commit (in the portfolio-orchestration-platform repo)**

```bash
cd /home/maxjeffwell/GitHub_Projects/portfolio-orchestration-platform
git add k8s/configmaps/coredns-custom.yaml
git commit -m "fix(dns): add asustor-smb.home.arpa, repoint backrest off dead WireGuard IP

The home-arpa.server key existed only in the live cluster; the tracked
file lacked it entirely, so applying this file would have deleted the
zone. Captures live state and extends it.

backrest.home.arpa pointed at 10.0.0.1, an address on the retired
WireGuard overlay. It is an Ingress host, so it now resolves to the
traefik LoadBalancer addresses 100.64.0.1 and 100.64.0.2.

asustor-smb.home.arpa is added for the smb-asustor StorageClass."
```

---

### Task 3: Install the driver via ArgoCD

**Files:**
- Create: `helm-charts/csi-driver-smb/values-override.yaml`
- Create: `gitops/applications/csi-driver-smb.yaml`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: CSIDriver `smb.csi.k8s.io` registered; DaemonSet `csi-smb-node` in `kube-system` running on all 4 nodes; Deployment `csi-smb-controller` running. Task 4's StorageClass requires the CSIDriver to exist.

- [ ] **Step 1: Verify the driver is absent**

```bash
kubectl get csidrivers smb.csi.k8s.io
kubectl get sc smb-asustor
```

Expected: `NotFound` for both. This is the "failing test" — it establishes the starting state.

- [ ] **Step 2: Create the values override**

Create `helm-charts/csi-driver-smb/values-override.yaml`:

```yaml
# Overrides for the upstream csi-driver-smb chart (v1.20.3).
#
# Deliberately minimal. Verified-correct chart defaults that must NOT be
# overridden are documented in
# docs/superpowers/specs/2026-08-01-csi-driver-smb-design.md:
#   linux.tolerations  [{operator: Exists}]  -> required for marmoset's
#                                               workload=gpu:NoSchedule taint
#   linux.kubelet      /var/lib/kubelet      -> k3s here uses the standard path
#   linux.dnsPolicy    ClusterFirstWithHostNet -> required so the node plugin can
#                                               resolve asustor-smb.home.arpa
#   feature.enableGetVolumeStats: true       -> already the default

# This is a Linux-only cluster. The chart ships windows.enabled=true by
# default, which creates a DaemonSet that can never schedule here.
windows:
  enabled: false

# Chart default is logLevel 5, which is extremely verbose and ships straight
# into Loki on every mount operation. 2 keeps errors and warnings.
controller:
  logLevel: 2

node:
  logLevel: 2
```

- [ ] **Step 3: Render the chart locally to prove the override is valid before ArgoCD sees it**

```bash
helm repo add csi-driver-smb https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
helm repo update csi-driver-smb
helm template csi-driver-smb csi-driver-smb/csi-driver-smb \
  --version v1.20.3 \
  --namespace kube-system \
  -f helm-charts/csi-driver-smb/values-override.yaml > /tmp/smb-rendered.yaml
```

Expected: renders without error.

- [ ] **Step 4: Assert the rendered output matches the design's requirements**

```bash
grep -c "csi-smb-node-win" /tmp/smb-rendered.yaml
grep -A2 "tolerations:" /tmp/smb-rendered.yaml | head -20
grep "path: /var/lib/kubelet" /tmp/smb-rendered.yaml | head -3
```

Expected: `0` occurrences of `csi-smb-node-win` (Windows disabled); the node DaemonSet's tolerations contain `operator: Exists`; kubelet paths are `/var/lib/kubelet`.

If the toleration check fails, the node plugin will not schedule onto `marmoset` and SMB volumes will be unmountable there.

- [ ] **Step 5: Create the ArgoCD Application**

Create `gitops/applications/csi-driver-smb.yaml`:

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: csi-driver-smb
  namespace: argocd
  labels:
    app: csi-driver-smb
    infrastructure: "true"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  sources:
    - repoURL: https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
      chart: csi-driver-smb
      targetRevision: v1.20.3
      helm:
        valueFiles:
          - $values/helm-charts/csi-driver-smb/values-override.yaml
    - repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
      targetRevision: main
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: kube-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=false
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

- [ ] **Step 6: Commit and push so ArgoCD can see it**

```bash
git add helm-charts/csi-driver-smb/values-override.yaml gitops/applications/csi-driver-smb.yaml
git commit -m "feat(storage): install csi-driver-smb v1.20.3 via ArgoCD

Linux-only cluster, so windows.enabled=false. Chart default tolerations
(operator: Exists) are kept deliberately so the node plugin schedules onto
marmoset despite its workload=gpu:NoSchedule taint."
git push origin main
```

The push is required: ArgoCD reads from GitHub, not the working tree.

- [ ] **Step 7: Sync and wait**

```bash
kubectl -n argocd get app csi-driver-smb -o wide
argocd app sync csi-driver-smb || kubectl -n argocd patch app csi-driver-smb \
  --type merge -p '{"operation":{"sync":{}}}'
kubectl -n kube-system rollout status daemonset/csi-smb-node --timeout=180s
kubectl -n kube-system rollout status deployment/csi-smb-controller --timeout=180s
```

- [ ] **Step 8: Verify the driver registered on every node**

```bash
kubectl get csidrivers smb.csi.k8s.io
kubectl -n kube-system get pods -l app=csi-smb-node -o wide
```

Expected: CSIDriver exists; **4** node pods, one per node, including one on `marmoset`. Anything fewer than 4 means a scheduling problem — check tolerations before proceeding.

- [ ] **Step 9: Verify the node plugin can resolve the DNS name**

```bash
POD=$(kubectl -n kube-system get pods -l app=csi-smb-node -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system exec "$POD" -c smb -- nslookup asustor-smb.home.arpa
```

Expected: `192.168.50.149`. This proves `ClusterFirstWithHostNet` works from the host-network plugin — the assumption the whole DNS-name decision rests on. If it fails, Task 4's StorageClass will provision but never mount.

---

### Task 4: ExternalSecret and StorageClass

**Files:**
- Create: `k8s/storage/csi-driver-smb/externalsecret.yaml`
- Create: `k8s/storage/csi-driver-smb/storageclass.yaml`
- Modify: `gitops/applications/csi-driver-smb.yaml` (append the second Application)

**Interfaces:**
- Consumes: Doppler keys from Task 1; `asustor-smb.home.arpa` from Task 2; CSIDriver `smb.csi.k8s.io` from Task 3.
- Produces: Secret `smbcreds` in `kube-system` with keys `username`/`password`; StorageClass `smb-asustor`. Task 5 provisions against both.

- [ ] **Step 1: Verify the secret does not exist**

```bash
kubectl -n kube-system get secret smbcreds
```

Expected: `NotFound`.

- [ ] **Step 2: Create the ExternalSecret**

Create `k8s/storage/csi-driver-smb/externalsecret.yaml`:

```yaml
---
# Pulls the ASUSTOR SMB credential from Doppler into the Secret that
# csi-driver-smb reads for both provisioning and node-stage operations.
#
# The driver requires the keys to be named exactly `username` and `password`,
# so the Doppler key names are remapped via secretKey.
#
# deletionPolicy: Retain — if the Doppler store is briefly unreachable, do not
# delete the Secret out from under live mounts.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: smbcreds-external-secret
  namespace: kube-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: doppler-secret-store
  target:
    name: smbcreds
    creationPolicy: Owner
    deletionPolicy: Retain
  data:
    - secretKey: username
      remoteRef:
        key: ASUSTOR_SMB_USERNAME
    - secretKey: password
      remoteRef:
        key: ASUSTOR_SMB_PASSWORD
```

- [ ] **Step 3: Create the StorageClass**

Create `k8s/storage/csi-driver-smb/storageclass.yaml`:

```yaml
---
# Dynamic SMB provisioning against the ASUSTOR AS5402T.
#
# Each PVC becomes a subdirectory named for its PV under //<source>/k8s-smb.
# The subdirectory behaviour is enabled by the presence of the
# provisioner-secret parameters; without them the driver would mount the whole
# share instead.
#
# `source` is copied into every PV's volumeAttributes at provision time and is
# IMMUTABLE per-PV. It is a DNS name, not an IP, so that failing over to
# .142/.133 is a coredns-custom edit rather than a rebuild of every PV.
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: smb-asustor
provisioner: smb.csi.k8s.io
parameters:
  source: //asustor-smb.home.arpa/k8s-smb
  csi.storage.k8s.io/provisioner-secret-name: smbcreds
  csi.storage.k8s.io/provisioner-secret-namespace: kube-system
  csi.storage.k8s.io/node-stage-secret-name: smbcreds
  csi.storage.k8s.io/node-stage-secret-namespace: kube-system
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
mountOptions:
  # SMB servers can hand out duplicate inode numbers across a share. A client
  # that caches them will alias distinct files onto each other. The upstream
  # chart annotates this option as "required to prevent data corruption".
  - noserverino
  # cache=strict follows SMB2 lease/oplock semantics: the server breaks the
  # lease when another client writes, invalidating the local cache. This is the
  # SAFE choice for the Windows-interop goal. (cache=loose is the dangerous one
  # — it assumes exclusive access and ignores other writers.)
  - cache=strict
  # Emulate symlinks via Minshall+French encoding; the share has no POSIX
  # extensions, so without this symlink creation fails outright.
  - mfsymlinks
  # SMB has no server-side uid mapping. Every file presents as this uid/gid
  # regardless of a pod's securityContext, so the modes must be permissive
  # enough for any consumer.
  - uid=0
  - gid=0
  - file_mode=0777
  - dir_mode=0777
  # Pin the dialect rather than negotiating down.
  - vers=3.1.1
  # The Linux client NEVER uses multichannel unless the mount asks. The server
  # advertises eth0/eth1/eth2, so LAN nodes bind up to 3 channels.
  # Caveat: on the two Contabo nodes all three advertised paths funnel through
  # the single Tailscale subnet-router tunnel, so the extra channels add
  # overhead without bandwidth. Accepted for a single cluster-wide class.
  - multichannel
  - max_channels=3
```

- [ ] **Step 4: Validate both manifests server-side without persisting them**

```bash
kubectl apply --dry-run=server -f k8s/storage/csi-driver-smb/
```

Expected: both objects report `(server dry run)` with no errors. A schema error here (for example `external-secrets.io/v1beta1` vs `v1`) is far cheaper to catch now than through an ArgoCD sync loop.

- [ ] **Step 5: Append the resources Application**

Append to `gitops/applications/csi-driver-smb.yaml`:

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: csi-driver-smb-resources
  namespace: argocd
  labels:
    app: csi-driver-smb
    infrastructure: "true"
spec:
  project: default
  source:
    repoURL: https://github.com/maxjeffwell/devops-portfolio-manager.git
    targetRevision: main
    path: k8s/storage/csi-driver-smb
  destination:
    server: https://kubernetes.default.svc
    namespace: kube-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=false
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

Note this brings `k8s/storage/` under ArgoCD management for the first time — the existing subdirectories there are applied by hand. Only the new `csi-driver-smb` path is synced; nothing else in `k8s/storage/` is touched.

- [ ] **Step 6: Commit and push**

```bash
git add k8s/storage/csi-driver-smb/ gitops/applications/csi-driver-smb.yaml
git commit -m "feat(storage): add smb-asustor StorageClass and Doppler-backed smbcreds

Dynamic provisioning into //asustor-smb.home.arpa/k8s-smb. Addressed by
DNS name because source is immutable per-PV. mountOptions include
noserverino (upstream flags it as required to prevent corruption) and
cache=strict, which honours SMB2 lease breaks and so is safe alongside
Windows clients writing the same share."
git push origin main
```

- [ ] **Step 7: Sync and verify the Secret materialised**

```bash
argocd app sync csi-driver-smb-resources || kubectl -n argocd patch app csi-driver-smb-resources \
  --type merge -p '{"operation":{"sync":{}}}'
kubectl -n kube-system get externalsecret smbcreds-external-secret
kubectl -n kube-system get secret smbcreds -o jsonpath='{.data}' | tr ',' '\n'
```

Expected: ExternalSecret status `SecretSynced`/`True`; the Secret has exactly the keys `username` and `password`. Do not decode the password.

- [ ] **Step 8: Verify the StorageClass**

```bash
kubectl get sc smb-asustor -o yaml | grep -E "source:|reclaimPolicy|provisioner"
```

Expected: `provisioner: smb.csi.k8s.io`, `source: //asustor-smb.home.arpa/k8s-smb`, `reclaimPolicy: Retain`.

---

### Task 5: End-to-end verification

Proves the whole path works, and — equally important — that `Retain` behaves as intended before any real workload depends on it.

**Files:**
- Create: `k8s/storage/csi-driver-smb/test/test-pvc.yaml` (temporary; deleted in this task, never committed)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: a verified working `smb-asustor` class. No lasting artifacts.

- [ ] **Step 1: Write the test manifest**

Create `k8s/storage/csi-driver-smb/test/test-pvc.yaml`:

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: smb-test-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: smb-asustor
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: smb-test-pod
  namespace: default
spec:
  # Pinned to a LAN node so the first test exercises the native path rather
  # than the Tailscale subnet router.
  nodeName: debian-marmoset
  containers:
    - name: writer
      image: busybox:1.36
      command: ["sh", "-c", "echo smb-ok > /data/canary.txt && sleep 3600"]
      volumeMounts:
        - name: smb
          mountPath: /data
  volumes:
    - name: smb
      persistentVolumeClaim:
        claimName: smb-test-pvc
  restartPolicy: Never
```

- [ ] **Step 2: Apply and wait for Bound**

```bash
kubectl apply -f k8s/storage/csi-driver-smb/test/test-pvc.yaml
kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc/smb-test-pvc -n default --timeout=120s
kubectl get pvc smb-test-pvc -n default
```

Expected: `Bound`. If it stays `Pending`, read the controller log:
`kubectl -n kube-system logs deploy/csi-smb-controller -c smb --tail=50`

- [ ] **Step 3: Verify the pod mounted and wrote**

```bash
kubectl wait --for=condition=Ready pod/smb-test-pod -n default --timeout=120s
kubectl exec -n default smb-test-pod -- cat /data/canary.txt
```

Expected: `smb-ok`.

- [ ] **Step 4: Verify the subdirectory on the NAS**

```bash
PV=$(kubectl get pvc smb-test-pvc -n default -o jsonpath='{.spec.volumeName}')
echo "PV: $PV"
ssh Asustor "ls -la /volume1/k8s-smb/ && cat '/volume1/k8s-smb/$PV/canary.txt'"
```

Expected: a directory named for the PV, containing `canary.txt` with `smb-ok`. This proves dynamic subdirectory provisioning, not whole-share mounting.

- [ ] **Step 5: Verify the mount is real CIFS and check the negotiated channels**

```bash
NODEPOD=$(kubectl -n kube-system get pods -l app=csi-smb-node \
  --field-selector spec.nodeName=debian-marmoset \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system exec "$NODEPOD" -c smb -- mount | grep cifs
ssh 100.64.0.12 'sudo grep -iE "Number of channels|Speed|Server interfaces" /proc/fs/cifs/DebugData | head -20'
```

Expected: a `cifs` mount referencing `//asustor-smb.home.arpa/k8s-smb`; `DebugData` reports more than 1 channel and lists the server's advertised interfaces.

If it reports 1 channel, multichannel is not active — check `server multi channel support = yes` in the ASUSTOR's `smb.conf` first, since ADM regenerating that file silently disables it.

- [ ] **Step 6: Verify Retain actually retains**

```bash
kubectl delete -f k8s/storage/csi-driver-smb/test/test-pvc.yaml
kubectl get pv "$PV"
ssh Asustor "cat '/volume1/k8s-smb/$PV/canary.txt'"
```

Expected: the PV survives in `Released` phase, and the file still exists on the NAS. This is the behaviour that makes `Retain` a safety net rather than a label.

- [ ] **Step 7: Clean up the test artifacts**

```bash
kubectl delete pv "$PV" --ignore-not-found
ssh Asustor "rm -rf '/volume1/k8s-smb/$PV'"
rm -rf k8s/storage/csi-driver-smb/test
ssh Asustor "ls -la /volume1/k8s-smb/"
```

Expected: `/volume1/k8s-smb/` is empty again.

The test directory is deleted rather than committed — a manifest that provisions storage on every ArgoCD sync does not belong in a synced path.

- [ ] **Step 8: Confirm both Applications are healthy and nothing else regressed**

```bash
kubectl -n argocd get app csi-driver-smb csi-driver-smb-resources
kubectl get sc smb-asustor
kubectl -n argocd get app | grep -v "Synced.*Healthy" || echo "all apps Synced/Healthy"
```

Expected: both new apps `Synced`/`Healthy`; no other application degraded.

- [ ] **Step 9: Commit the final state**

```bash
git status --short
git add -A
git commit -m "chore(storage): verified smb-asustor end-to-end

Dynamic provisioning, subdirectory-per-PV, multichannel, and Retain
semantics all confirmed against the ASUSTOR. Test manifests removed."
git push origin main
```

If `git status` is clean (the test directory was the only untracked change and it is deleted), skip the commit.

---

## Post-implementation notes

Record in memory once complete, since none of it is derivable from the repo:

- `smb-asustor` exists, backed by `//asustor-smb.home.arpa/k8s-smb` → `192.168.50.149`, `Retain`, RWX-capable.
- The failover procedure: edit `home-arpa.server` in `coredns-custom`, restart CoreDNS. No PV rebuild. This is the entire reason the source is a name.
- ADM regenerating `smb.conf` silently degrades multichannel to one channel. A throughput regression on SMB PVs should send you to `smb.conf` before anywhere else.
