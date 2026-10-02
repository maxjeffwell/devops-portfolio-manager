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

## 2026-10-02: spread load (cpu:mem 1:1, NodeResourcesFit plugin weight 2)
With memory weighted 3x, the two 29 GiB nodes (elitedesk, m720q) kept winning
until they reached 73-83 % CPU requested while the others sat at 14-34 %.
Now LeastAllocated weighs cpu and memory equally and the NodeResourcesFit
score counts double, so free resources outweigh BalancedAllocation and
ImageLocality. Verified with two unconstrained pause pods: both scheduled to
the least-requested node (neonmarmoset). Rolled out one server at a time.
Trade-off accepted by the user: memory is no longer favored, so the
memory-fuller small nodes (m920s, debian-marmoset) fill toward their limits.
Do NOT up-weight NodeResourcesBalancedAllocation (tried first, reverted
79e3e01): it rewards nodes whose cpu% and mem% are close even when both are
high, which made m720q the top-scoring node.
