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
