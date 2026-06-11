# NodeLocal DNSCache — Rollback Runbook

Deleting the DaemonSet does NOT remove the NOTRACK iptables rules or the dummy
`nodelocaldns` interface from each node. Orphaned, they route 10.43.0.10 to an
absent listener and WEDGE DNS on that node. Roll back in this order:

1. Stop ArgoCD fighting the teardown — delete the Application (its finalizer
   cleans the workloads):
       kubectl delete application nodelocaldns -n argocd
   (Or, to keep the app, set its syncPolicy.automated to null and sync manually.)

2. GRACEFUL pod teardown first — node-cache cleans its own iptables + interface on
   SIGTERM, so let it before the objects vanish:
       kubectl -n kube-system delete pod -l k8s-app=node-local-dns --grace-period=30

3. Confirm DNS still resolves on each affected node (see verification below). If a
   node is wedged (node-cache was force-killed / node crashed), clean it manually
   via a debug pod:
       kubectl debug node/<NODE> -it --image=nicolaka/netshoot --profile=sysadmin -- \
         nsenter -t 1 -n -- sh -c '
           iptables-save | grep -E "169.254.20.10|10.43.0.10" ;
           # delete each matching rule shown above with: iptables -t <table> -D <chain> <rule>
           ip link del nodelocaldns 2>/dev/null || true'

## Verify DNS healthy on a node
    kubectl run dns-rb-check --rm -it --restart=Never --image=busybox:1.36 \
      --overrides='{"spec":{"nodeName":"<NODE>"}}' -- nslookup kubernetes.default
Expected: resolves to 10.43.0.1.
