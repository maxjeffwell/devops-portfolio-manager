# DevOps Portfolio Manager

Automated DevOps platform implementing GitOps workflows for portfolio applications. Features CI/CD pipelines with GitHub Actions, automated Kubernetes deployments, rollback capabilities, and infrastructure-as-code with Helm charts.

## Features

- **GitOps Workflows**: Declarative infrastructure and application management
- **CI/CD Pipelines**: Automated build, test, and deploy with GitHub Actions
- **Helm Charts**: Infrastructure-as-code for all portfolio applications
- **Automated Deployments**: Push-to-deploy workflow with automated rollouts
- **Rollback Capabilities**: One-command rollback to previous versions
- **Multi-Application Management**: Centralized management of all portfolio apps
- **Health Monitoring**: Post-deployment health checks and validation
- **Docker Registry Integration**: Automated image building and pushing

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              GitHub Repository                           │
│         (Source Code + Helm Charts)                      │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ Git Push
                 ▼
┌─────────────────────────────────────────────────────────┐
│           GitHub Actions CI/CD                           │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐     │
│  │ Build &    │→ │ Run Tests  │→ │ Build Docker │     │
│  │ Lint       │  │            │  │ Image        │     │
│  └────────────┘  └────────────┘  └──────┬───────┘     │
│                                          │              │
│                                          ▼              │
│                              ┌──────────────────┐      │
│                              │ Push to Registry │      │
│                              └────────┬─────────┘      │
└───────────────────────────────────────┼────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────┐
│          GitOps Sync Service                            │
│  Watches for changes and applies Helm releases          │
└────────────────┬────────────────────────────────────────┘
                 │
                 │ kubectl apply / helm upgrade
                 ▼
┌─────────────────────────────────────────────────────────┐
│          Kubernetes Cluster                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │Bookmarked│  │ FireBook │  │Interval- │  + more     │
│  │          │  │          │  │   AI     │             │
│  └──────────┘  └──────────┘  └──────────┘             │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
devops-portfolio-manager/
├── .github/
│   └── workflows/              # GitHub Actions CI/CD pipelines
│       ├── build-and-deploy.yml
│       ├── rollback.yml
│       └── helm-lint.yml
├── helm-charts/                # Helm charts for each application
│   ├── bookmarked/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   └── templates/
│   ├── firebook/
│   ├── educationelly/
│   ├── educationelly-graphql/
│   ├── code-talk/
│   ├── intervalai/
│   └── orchestration-platform/
├── gitops/
│   ├── applications/           # Application manifests
│   │   ├── bookmarked.yaml
│   │   └── ...
│   └── sync-service/           # GitOps sync service
│       ├── Dockerfile
│       ├── sync.js
│       └── config.yaml
├── scripts/
│   ├── deploy.sh               # Deployment script
│   ├── rollback.sh             # Rollback script
│   └── build-all.sh            # Build all images
├── config/
│   ├── environments/           # Environment-specific configs
│   │   ├── dev.yaml
│   │   ├── staging.yaml
│   │   └── production.yaml
│   └── registry.yaml           # Docker registry configuration
└── docs/
    ├── SETUP.md                # Setup instructions
    ├── DEPLOYMENT.md           # Deployment guide
    └── ROLLBACK.md             # Rollback procedures
```

## Managed Applications

This DevOps platform manages deployments for:

1. **Bookmarked** - Bookmark management application
2. **FireBook** - Social networking platform
3. **EducationELLy** - Educational platform for language learners
4. **EducationELLy GraphQL** - GraphQL API for EducationELLy
5. **Code Talk** - Code collaboration and review platform
6. **IntervalAI** - ML-powered spaced repetition system
7. **Orchestration Platform** - Kubernetes management dashboard

## Quick Start

### Prerequisites

- kubectl configured with cluster access
- Helm 3+
- Docker
- GitHub repository with Actions enabled

### 1. Install Helm Charts

```bash
# Deploy a single application
cd helm-charts/intervalai
helm install intervalai . -n default

# Deploy all applications
./scripts/deploy.sh --all
```

### 2. Set up CI/CD Pipeline

```bash
# Configure GitHub secrets
gh secret set DOCKERHUB_USERNAME --body "your-username"
gh secret set DOCKERHUB_TOKEN --body "your-token"
gh secret set KUBECONFIG --body "$(cat ~/.kube/config | base64)"

# Push changes to trigger pipeline
git add .
git commit -m "Deploy updates"
git push origin main
```

### 3. Deploy GitOps Sync Service

```bash
cd gitops/sync-service
docker build -t devops-sync-service .
kubectl apply -f deployment.yaml
```

## CI/CD Workflow

The platform uses GitHub Actions for continuous integration and deployment:

1. **On Push to Main**:
   - Lint and validate code
   - Run automated tests
   - Build Docker image
   - Push to Docker registry
   - Update Helm values with new image tag
   - Deploy to Kubernetes cluster

2. **On Pull Request**:
   - Run linting and tests
   - Build Docker image (no push)
   - Report status checks

3. **Manual Deployment**:
   ```bash
   gh workflow run build-and-deploy.yml -f app=intervalai -f version=v1.2.3
   ```

## Deployment

### Deploy Single Application

```bash
./scripts/deploy.sh --app intervalai --version v1.0.0
```

### Deploy Multiple Applications

```bash
./scripts/deploy.sh --apps bookmarked,firebook,intervalai
```

### Deploy to Specific Environment

```bash
./scripts/deploy.sh --app intervalai --env production
```

## Rollback

### Rollback to Previous Version

```bash
./scripts/rollback.sh --app intervalai --revision 1
```

### Rollback All Applications

```bash
./scripts/rollback.sh --all
```

### View Rollout History

```bash
helm history intervalai -n default
```

## GitOps Sync Service

The sync service continuously monitors the Git repository and automatically applies changes to the Kubernetes cluster:

- **Automatic Sync**: Polls repository every 60 seconds
- **Helm Release Management**: Applies Helm chart updates
- **Health Checks**: Validates deployments post-sync
- **Rollback on Failure**: Automatically rolls back failed deployments

### Configuration

Edit `gitops/sync-service/config.yaml`:

```yaml
sync:
  interval: 60s
  branch: main
  auto-rollback: true
applications:
  - name: intervalai
    path: helm-charts/intervalai
    namespace: default
  - name: bookmarked
    path: helm-charts/bookmarked
    namespace: default
```

## Helm Charts

Each application has a Helm chart with:

- **Deployment** configuration
- **Service** definitions
- **Ingress** rules
- **ConfigMaps** and **Secrets**
- **HPA** (Horizontal Pod Autoscaler)
- **ServiceMonitor** for Prometheus

### Customize Helm Values

```yaml
# helm-charts/intervalai/values.yaml
replicaCount: 3
image:
  repository: maxjeffwell/spaced-repetition-capstone-server
  tag: latest
  pullPolicy: Always
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 250m
    memory: 256Mi
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 80
```

## Environment Management

Manage different environments with value overrides:

```bash
# Development
helm install intervalai ./helm-charts/intervalai -f config/environments/dev.yaml

# Staging
helm install intervalai ./helm-charts/intervalai -f config/environments/staging.yaml

# Production
helm install intervalai ./helm-charts/intervalai -f config/environments/production.yaml
```

## Monitoring and Observability

- **Prometheus**: Metrics collection from all applications
- **Grafana**: Visualization dashboards
- **Loki**: Log aggregation
- **Jaeger**: Distributed tracing

## Security

- **RBAC**: Role-based access control for service accounts
- **Secrets Management**: Kubernetes secrets for sensitive data
- **Image Scanning**: Automated vulnerability scanning in CI pipeline
- **Network Policies**: Pod-to-pod communication restrictions

## Best Practices

1. **Immutable Infrastructure**: Always deploy new versions, never modify running containers
2. **Semantic Versioning**: Use semver for all releases
3. **Blue-Green Deployments**: Zero-downtime deployments with gradual rollout
4. **Automated Testing**: Tests run before every deployment
5. **Infrastructure as Code**: All configuration in version control

## Troubleshooting

### Deployment Failed

```bash
# Check deployment status
kubectl get deployments -n default
kubectl describe deployment intervalai -n default

# View pod logs
kubectl logs -n default -l app=intervalai --tail=100

# Check Helm release status
helm status intervalai -n default
```

### Rollback Failed

```bash
# List available revisions
helm history intervalai -n default

# Manual rollback to specific revision
helm rollback intervalai 2 -n default
```

### GitOps Sync Issues

```bash
# Check sync service logs
kubectl logs -n default -l app=gitops-sync

# Manually trigger sync
kubectl exec -n default gitops-sync-pod -- /app/sync.sh
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - See LICENSE file for details

## Author

**Jeff Maxwell**
- Portfolio: [el-jefe.me](https://el-jefe.me)
- GitHub: [@maxjeffwell](https://github.com/maxjeffwell)
- Email: jeff@el-jefe.me

## Acknowledgments

- Kubernetes and Helm communities
- GitHub Actions ecosystem
- GitOps working group
