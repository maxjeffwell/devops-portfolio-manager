# ovms-legacy-gpu

OpenVINO Model Server with Intel's legacy GPU driver added, so it can use
integrated graphics older than Xe (here: the UHD Graphics 630 in m920s). Used by
the `ovms-gpu-graph-legacy` ServingRuntime in `k8s/ovms/kserve-runtime.yaml`.

Build and push by hand when the base image version changes (keep the tag equal
to the model server version):

```sh
docker build -t maxjeffwell/ovms-legacy-gpu:2026.4.1 docker/ovms-legacy-gpu
docker push maxjeffwell/ovms-legacy-gpu:2026.4.1
```

Measured 2026-11-26 against the Iris Xe laptops with the same models: embedding
vectors and rerank scores are exactly equal; single requests take the same time,
batches are two to five times slower.
