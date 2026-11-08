# Tdarr flows (reference copies)

Flows live in Tdarr's database (`tdarr-server-data` PVC, FlowsJSONDB); these are
exported copies for review and restore. They are NOT applied by ArgoCD — the
directory is not in kustomization.yaml.

`hevc-qsv-h264-over-10mbps.json` (2026-10-07), used by the Movies and TV Shows
libraries (processing 01:00-07:00 America/New_York, new files held 1 h):

1. Input File (access checks on)
2. Only H.264 continues; anything else (HEVC, ...) ends untouched
3. Only overall bitrate > 10 Mbps continues (some Rokus lack HEVC, so typical
   ~8 Mbps web releases stay H.264 for direct play)
4. hevc_qsv `-global_quality 18 -preset slow`, all audio/subtitle streams copied
   (q18 chosen after q25/q22/q20/q18 tests on Homeland S07E02: q22 visibly soft)
5. Health check (quick, QSV) on the output
6. Duration within 0.5% of the original, else fail (original kept)
7. Size 10-85% of the original: <10% fail, >85% not worth it (original kept)
8. Replace original

Restore: POST /api/v2/cruddb {"data":{"collection":"FlowsJSONDB","mode":"insert","docID":<_id>,"obj":<json>}}
via `kubectl port-forward -n tdarr svc/tdarr 8265`.

## Library settings (2026-11-07)

`libraries-2026-11-07.json` is the trimmed LibrarySettingsJSONDB export (Movies
`CYdhvudPu`, TV Shows `LjOT36vGa`) after these changes, applied via cruddb
`mode: update`:

- Health check type: Quick (`handbrakescan: true`, `ffmpegscan: false`). The
  library check used to be Thorough = a full FFmpeg decode of every new file on
  the Xe; the flow already runs its own quick check on every transcoded output
  (step 5), so Thorough at the library level only re-verified untouched files.
- Folder watching OFF (`folderWatching: false`). It polled the NFS tree every
  30 s (no inotify over NFS). New files are picked up by the hourly scheduled
  scan (`scheduledScanFindNew: true`) and still held 1 h before processing.
- Codecs to skip: `hevc,av1` so already-efficient files never enter the queue
  (the flow rejected them anyway, after a scan + health check).
- MediaInfo and ExifTool scans left ON on purpose.

Pre-change DB2 snapshot: ~/tdarr-backups/DB2-pre-change-20261107T220724.tgz on
marmoset (restore = untar into /app/server/Tdarr on the tdarr-server-data PVC).

## v3 upgrade (staged 2026-11-07)

Server + node pinned together to 3.06.00 (upstream requires matching versions;
3.06.00 also fixes nodes failing to connect when `serverIP=0.0.0.0`). Upstream
publishes no changelog for 3.x; known from downstream trackers: `serverIP` /
`serverPort` are deprecated in favour of `serverURL` (both still honoured in
3.06), 3.03/3.04 bumped the bundled Node runtime for plugins. Upgrade outside
the 01-07 transcode window with the queue empty; take a DB2 snapshot first;
re-check `/api/v2/get-nodes` (both nodes, unpaused, schedule intact) and the
libraries' `handbrakescan`/`filterCodecsSkip` after the roll.
