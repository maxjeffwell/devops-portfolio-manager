# Unified Jellyfin Recordings Browse — Design (2026-06-06)

## Goal
Both Jellyfin servers can browse **all** recordings from all three DVR engines,
**without changing where any engine records**. Read-only cross-access only — no
recorder's write location or behavior changes; tuner usage is unaffected.

- **k8s Jellyfin** — `jellyfin-k8s.el-jefe.me` (ns `jellyfin`, on debian-marmoset)
- **ASUSTOR Jellyfin** — Docker container `Jellyfin` on the ASUSTOR, `:28096`, docker-compose-managed

## Current recording locations (unchanged)
| Engine | Host path | Volume |
|---|---|---|
| Channels DVR | `/volume1/channels-data` | vol1 |
| ASUSTOR Jellyfin | `/share/Media/Jellyfin-Recordings` | vol1 |
| k8s Jellyfin | `/volume2/Recordings` | vol2 (NFS) |

## Approach
Each Jellyfin mounts the folders it does **not** own as **read-only**, then adds
them as libraries. Read-only prevents two servers scanning/managing the same
folder (no `.nfo`/metadata scan-wars); each server keeps full read-write
ownership of the single folder it records into. Purely additive *viewing*.

## ASUSTOR Jellyfin (docker-compose)
Add one read-only bind to the compose `volumes:`:
```yaml
- /volume2/Recordings:/media/k8s-recordings:ro
```
Then `docker-compose up -d` (recreates; `/config` bind mount preserves settings).
After: container sees Channels (`/media/dvr`, ro, existing) + own
(`/media/Jellyfin-Recordings`) + k8s (`/media/k8s-recordings`, ro, new).
k8s recordings are owned `1000:1000`; files are `644` (world-readable) so the
ASUSTOR JF can read them fine.

## k8s Jellyfin (GitOps — `k8s/jellyfin/`)
1. **ASUSTOR NFS exports (ro)** for the two vol1 folders, persisted via the
   `S60nfs-recordings` Entware boot-script pattern (extend it or add siblings;
   uses full-path `/usr/builtin/sbin/exportfs`):
   - `/volume1/channels-data`
   - ASUSTOR-JF folder — verify the real exportable path (`/share/Media/Jellyfin-Recordings`
     resolves to a vol1 path; export that).
2. **New PVs/PVCs** (`ReadOnlyMany`, NFS, mountOptions `ro,vers=3,nolock,hard,nconnect=8`
   — `nconnect=8` to match the existing `.133` mounts so it's honored):
   - `jellyfin-rec-channels` → `192.168.50.133:/volume1/channels-data` → mount `/media/channels-rec` (ro)
   - `jellyfin-rec-asustor`  → `192.168.50.133:/share/Media/Jellyfin-Recordings` → mount `/media/asustor-rec` (ro)
3. **deployment.yaml**: add the 2 ro volumeMounts + volumes; add both names to the
   `backup.velero.io/backup-volumes-excludes` annotation; **kustomization.yaml** adds the 2 files.
4. Commit to `main` → ArgoCD sync → `Recreate` rollout.

## Libraries (both Jellyfins, once mounts are live)
Add the 3 recording folders as libraries (one "Recordings" library with 3 path
entries, or 3 labeled libraries). Content type: **Shows** or **Mixed**
(recordings skew series/sports with some movies).

## Risks / notes
- ASUSTOR container recreate via compose: low risk (settings persist in `/config`).
- 2 new NFS exports need boot persistence (same not-yet-reboot-tested caveat as
  the volume2 export; mitigated by the `S60` script pattern).
- No change to recording behavior, ownership of own-folders, or tuner usage.

## Out of scope
- Moving any recorder's write location.
- Deduplicating overlapping recordings across engines.

## Build order
1. ASUSTOR compose bind + `up -d` + add k8s library (quick win, verify browse).
2. k8s NFS exports + persistence on the ASUSTOR.
3. k8s PVs/PVCs/deployment/kustomization → commit → rollout → verify mounts.
4. Add libraries in the k8s Jellyfin → verify browse all three.
