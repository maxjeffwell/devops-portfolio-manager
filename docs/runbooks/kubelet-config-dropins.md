# kubelet config drop-ins (k3s)

Node-level kubelet settings that are **not** managed by Helm or ArgoCD. The
files in `config/kubelet.conf.d/` are the source of truth; applying them is a
manual per-node step, documented below.

> **Why this doc exists**: these files live on the nodes, outside every IaC
> path in this repo. A rebuilt node silently loses them and nothing fails —
> you just quietly get the old behaviour back. If you add a drop-in, add it
> here too.

## TL;DR

- **Where on the node**: `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/`
- k3s already passes `--config-dir` at that path, so drop-ins **merge** over
  k3s's generated kubelet config. Only the fields you name are overridden —
  unlike `--config`, which would replace the whole thing.
- Files must end in `.conf` and merge in lexical order, last wins. The `99-`
  prefix means ours applies after anything k3s ships.
- The directory is `0700 root`, so every step needs `sudo`.

## Applying

Stage the file, then copy and restart. **The unit differs by role**:
`k3s.service` on the control plane (`vmi2951245`), `k3s-agent.service` on
every worker.

```sh
scp config/kubelet.conf.d/99-cm-secret-cache.conf <node>:~/

# workers
ssh -t <node> "sudo cp ~/99-cm-secret-cache.conf /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/ && sudo systemctl restart k3s-agent"

# control plane (vmi2951245) -- this bounces the apiserver for ~30-60s
ssh -t vmi2951245 "sudo cp ~/99-cm-secret-cache.conf /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/ && sudo systemctl restart k3s"
```

Verify per node — this reads the kubelet's *live* config, not the file:

```sh
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['kubeletconfig']['configMapAndSecretChangeDetectionStrategy'])"
```

Rollback is `rm` the file and restart the same unit.

### Gotchas

- **`systemctl restart k3s-agent` does NOT restart containers.** The kubelet
  re-adopts the existing containerd state; verified on marmoset by checking
  container `startedAt` was unchanged across the restart. No cordon or drain
  is needed. The command just *looks* hung for 30–60s while it comes back.
- Nested heredocs inside `sudo sh -c '...'` fail in this shell. Copy the file
  in, don't try to write it inline.

## Drop-ins

### `99-cm-secret-cache.conf` — `configMapAndSecretChangeDetectionStrategy: Cache`

Applied to all 5 nodes 2026-08-24.

kubelet's default is `Watch`: it opens a watch per **(node, object)** pair for
every configmap and secret mounted by a pod on that node. With 83 distinct
configmaps and 42 secrets mounted across 290 pods, that is roughly
`83 × 5 = 415` and `42 × 5 = 210` watches that exist purely because five
kubelets each want their own.

That matters here because this cluster runs **kine on SQLite**, not etcd. etcd
serves watches from an in-memory index; kine translates them onto SQL against
a single-writer file. At 3,118 total watch channels the apiserver was burning
~1.5 cores while serving only 34 requests/s.

`Cache` re-reads on a TTL (~1 min) when a pod actually needs the value instead
of holding a watch open. Mounted configmaps and secrets still refresh — just up
to a minute later. That is the trade.

Measured before/after on `vmi2951245`:

| metric | before | after |
|---|---|---|
| configmap watches | 390 | 80 |
| secret watches | 235 | 70 |
| k3s-server CPU | 90–127% | 71% |
| alloy CPU (CP node) | 27–45% | 19–21% |
| load15 | ~9.3 | 7.32 |
| OS threads | 2,839 | 2,288 |

Note only ~475 of the watch reduction is attributable to this change — every
non-configmap/secret resource stayed flat. The larger drop seen at the time
also included the apiserver restart clearing informers.

**This is headroom, not a fix.** ~1,270 watches still run against kine on
SQLite and `vmi2951245`'s load15 is still 3–4× every other node. The real fix
is moving kine to an external datastore or switching k3s to embedded etcd.
