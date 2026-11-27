# Qdrant (`qdrant-ha`)

KubeBlocks-managed Qdrant, three replicas on the servers. Its only user is the
IntervalAI server (`intervalai-server` in `default`), which keeps one
collection, `intervalai_cards`: an embedding of every flashcard, used for
similar-card search.

## Backups and recovery

Qdrant holds a **derived index**, not original data. The cards themselves live
in IntervalAI's MongoDB database, which is backed up on its own. So the real
recovery path is to rebuild the vectors from that database, not to restore
Qdrant's files.

- Velero copies the three data volumes nightly (`daily-backup-nas-local`, the
  daily Garage backup and the weekly Backblaze backup). Those are copies of live
  files, so treat them as a convenience, not as the recovery plan.
- KubeBlocks' own backups (BackupRepo / BackupSchedule) are deliberately not
  used. Decided 2026-11-27: 120 vectors that one script recreates were not worth
  enabling the data-protection controller and its repository.

## Rebuilding the collection

Run the backfill from a running IntervalAI server pod. The image already has
the script, and the pod already has every setting it needs
(`VECTOR_SEARCH_ENABLED`, `MONGODB_URI`, `QDRANT_URL`, `OVMS_EMBED_URL`):

```sh
kubectl exec -n default deploy/intervalai-server -- node scripts/backfill-embeddings.js
```

What it does: creates the collection if it is missing (the server also does
this on startup), then reads every user's cards from MongoDB, embeds them
through the `ovms-embeddings` service and upserts them into Qdrant. Point IDs
are derived from the card, so running it on a populated collection updates
points in place without duplicating them. It ends with a log line
`Backfill complete` giving the number of users and points.

Check the result (the point count should match the number of cards):

```sh
kubectl port-forward -n qdrant svc/qdrant 16333:6333 &
curl -s localhost:16333/collections/intervalai_cards | jq '.result.points_count'
```

Needs: Qdrant up (an empty new cluster is fine), MongoDB reachable, and at least
one `ovms-embeddings` copy serving (`kubectl get endpointslices -n ovms -l
kubernetes.io/service-name=ovms-embeddings`). Source of the script:
`spaced-repetition-capstone-server/scripts/backfill-embeddings.js`.
