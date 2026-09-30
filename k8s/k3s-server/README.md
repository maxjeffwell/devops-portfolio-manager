# k3s server host config (records; installed by hand, NOT applied by ArgoCD)

| File | Destination on each k3s server (elitedesk, m720q, m920s) | Mode |
|---|---|---|
| scheduler-config.yaml | /etc/rancher/k3s/scheduler-config.yaml | 0644 |
| 20-scheduler-scoring.yaml | /etc/rancher/k3s/config.yaml.d/20-scheduler-scoring.yaml | 0644 |

Then `systemctl restart k3s`, one server at a time. Verify with
`journalctl -u k3s | grep -m1 'Running kube-scheduler'` (must show `--config=`)
and no scheduler errors. The three embedded schedulers elect one leader
(`kubectl -n kube-system get lease kube-scheduler`); only the leader's config
decides placements, so all three must carry the file.

## Why (2026-09-30)
Default `NodeResourcesFit` scoring weights CPU and memory equally. On this
cluster memory is the tight resource and CPU is mostly idle, so the node with
the most free CPU (m920s) kept winning placements for CPU-light, memory-heavy
pods even at ~76% memory requested. Memory now weighs 3x CPU in the
`LeastAllocated` score. No per-workload steering: placement stays the
scheduler's decision; taints exclude the nodes that must not host generic work.

Only affects NEW placements (Kubernetes never moves a running pod).
