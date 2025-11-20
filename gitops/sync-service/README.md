# GitOps Sync Service

Automated GitOps synchronization service that continuously monitors the Git repository and applies Helm chart changes to the Kubernetes cluster.

## Features

- **Automatic Sync**: Polls the Git repository at configurable intervals
- **Helm Integration**: Automatically installs and upgrades Helm releases
- **Health Checks**: Validates deployments after sync
- **Auto Rollback**: Automatically rolls back failed deployments
- **Multi-Application Support**: Manages multiple applications from a single service

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Run locally (requires kubectl and helm configured)
npm start

# Run with nodemon for development
npm run dev
```

### Build Docker Image

```bash
# Build the image
docker build -t maxjeffwell/gitops-sync-service:latest .

# Push to registry
docker push maxjeffwell/gitops-sync-service:latest
```

### Deploy to Kubernetes

```bash
# Deploy the sync service
kubectl apply -f deployment.yaml

# Check logs
kubectl logs -f -l app=gitops-sync-service

# Check status
kubectl get pods -l app=gitops-sync-service
```

## Configuration

Edit `config.yaml` to configure the sync service:

```yaml
sync:
  interval: 60s          # How often to check for changes
  branch: main           # Git branch to monitor
  autoRollback: true     # Auto-rollback failed deployments
  dryRun: false          # Test mode without applying changes

git:
  repository: https://github.com/maxjeffwell/devops-portfolio-manager.git
  chartsPath: helm-charts

applications:
  - name: bookmarked
    enabled: true         # Enable/disable auto-sync
    path: helm-charts/bookmarked
    namespace: default
    valueFiles:
      - values.yaml
    autoSync: true        # Auto-sync on changes
```

## How It Works

1. **Clone Repository**: Clones the Git repository on startup
2. **Monitor Changes**: Polls the repository at configured intervals
3. **Detect Changes**: Compares current commit with last processed commit
4. **Sync Applications**: For each enabled application:
   - Checks if Helm release exists
   - Installs new release or upgrades existing one
   - Performs health check
   - Rolls back on failure (if enabled)
5. **Repeat**: Continues monitoring in a loop

## Environment Variables

- `CONFIG_PATH`: Path to config.yaml (default: `/config/config.yaml`)

## Kubernetes RBAC

The service requires cluster-level permissions to manage resources:

- Deployments, Services, ConfigMaps, Secrets
- StatefulSets, DaemonSets, Jobs, CronJobs
- Ingresses, HorizontalPodAutoscalers
- And more (see `deployment.yaml` for full list)

## Health Checks

The service includes a liveness probe that checks if the Node.js process is running:

```bash
pgrep -f "node sync.js"
```

## Monitoring

View sync service logs:

```bash
# Follow logs
kubectl logs -f -l app=gitops-sync-service

# View recent logs
kubectl logs --tail=100 -l app=gitops-sync-service
```

## Troubleshooting

### Sync Not Running

```bash
# Check pod status
kubectl get pods -l app=gitops-sync-service

# Check events
kubectl describe pod -l app=gitops-sync-service

# Check logs for errors
kubectl logs -l app=gitops-sync-service
```

### Permission Errors

Ensure the service account has proper RBAC permissions:

```bash
kubectl get clusterrolebinding gitops-sync-service
kubectl describe clusterrole gitops-sync-service
```

### Git Authentication

For private repositories, add Git credentials:

```yaml
# Add to deployment.yaml
env:
  - name: GIT_USERNAME
    valueFrom:
      secretKeyRef:
        name: git-credentials
        key: username
  - name: GIT_PASSWORD
    valueFrom:
      secretKeyRef:
        name: git-credentials
        key: password
```

Then modify the repository URL in config.yaml:
```yaml
git:
  repository: https://${GIT_USERNAME}:${GIT_PASSWORD}@github.com/owner/repo.git
```

## Integration with ArgoCD

This sync service can work alongside ArgoCD:

- **Sync Service**: Monitors Git and applies Helm charts directly
- **ArgoCD**: Provides GitOps UI, sync status, and advanced features

Both can be used together or independently.

## License

MIT
