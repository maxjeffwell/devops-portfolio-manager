# DevOps Portfolio Manager - AI Agent Documentation

## Project Overview

**DevOps Portfolio Manager** is an automated DevOps platform implementing GitOps workflows for portfolio applications with CI/CD pipelines, automated Kubernetes deployments, and rollback capabilities.

### Purpose

This platform serves as a production-grade DevOps solution that manages the complete lifecycle of multiple portfolio applications through declarative infrastructure management and automated deployment workflows.

### Key Information

- **Author**: Jeff Maxwell
- **License**: MIT
- **Repository**: https://github.com/maxjeffwell/devops-portfolio-manager
- **Architecture**: Microservices-based with GitOps workflows

### Project Goals

1. **Implement production-grade GitOps workflows** for declarative infrastructure management
2. **Provide automated CI/CD pipelines** with GitHub Actions for continuous delivery
3. **Enable one-command deployments and rollbacks** for all portfolio applications
4. **Maintain infrastructure as code** using Helm charts for reproducibility
5. **Centralize management** of multiple portfolio applications in single platform
6. **Ensure zero-downtime deployments** with health monitoring and validation

### Managed Applications

The platform manages deployments for six portfolio applications:

1. **Bookmarked** - Bookmark management application
   - Helm Chart: `helm-charts/bookmarked`
   - Workflow: `.github/workflows/build-and-deploy-bookmarked.yml`

2. **FireBook** - Social networking platform
   - Helm Chart: `helm-charts/firebook`
   - Workflow: `.github/workflows/build-and-deploy-firebook.yml`

3. **EducationELLy** - Educational platform for language learners
   - Helm Chart: `helm-charts/educationelly`
   - Workflow: `.github/workflows/build-and-deploy-educationelly.yml`

4. **EducationELLy GraphQL** - GraphQL API for EducationELLy platform
   - Helm Chart: `helm-charts/educationelly-graphql`
   - Workflow: `.github/workflows/build-and-deploy-educationelly-graphql.yml`

5. **Code Talk** - Code collaboration and review platform
   - Helm Chart: `helm-charts/code-talk`
   - Workflow: `.github/workflows/build-and-deploy-code-talk.yml`

6. **IntervalAI** - ML-powered spaced repetition system
   - Helm Chart: `helm-charts/intervalai`
   - Workflow: `.github/workflows/build-and-deploy-intervalai.yml`

## Architecture Patterns

### GitOps Pattern

Git repository serves as the single source of truth for infrastructure and application state.

- **Sync Service**: Continuously monitors repository and applies changes to Kubernetes cluster
- **Declarative Configuration**: Ensures desired state matches actual state
- **Automated Reconciliation**: Platform automatically detects and applies changes

### CI/CD Pipeline Pattern

GitHub Actions automates the complete build, test, and deployment workflow.

- **Trigger Mechanisms**: Activated on push to main branch or manual workflow dispatch
- **Workflow Steps**: Builds Docker images, pushes to registry, updates Helm values, deploys to cluster
- **Automated Testing**: Runs linting and tests before every deployment
- **Health Validation**: Post-deployment checks ensure successful rollouts

### Infrastructure as Code Pattern

All infrastructure is defined in Helm charts with version control.

- **Per-Application Charts**: Separate Helm chart for each portfolio application
- **Environment Management**: Environment-specific value overrides for dev/staging/production
- **Reproducibility**: Complete infrastructure can be recreated from repository

### Microservices Pattern

The platform itself follows a microservices architecture:

- **Dashboard**: React SPA for visualization and management UI
- **API Backend**: Express backend for Kubernetes/Helm/GitHub/Prometheus integration
- **GitOps Sync Service**: Standalone service for automated deployments

### Deployment Strategy

- **Strategy**: Blue-Green Deployments for zero-downtime rollouts
- **Rollback**: Automated rollback on deployment failure when enabled
- **Health Checks**: Post-deployment validation ensures successful rollouts
- **Gradual Rollout**: Progressive deployment to minimize risk

## Technology Stack

### Languages

- **JavaScript (ES2020+)**: Modern JavaScript with async/await, arrow functions, and destructuring
- **Node.js**: Server-side JavaScript runtime for backend services

### Frontend

- **React 19.2.0**: Component-based UI library
- **Vite 7.2.4**: Fast build tool and development server
- **React Router DOM 7.9.6**: Client-side routing for single-page application

### Backend

- **Express 5.1.0**: Web framework for Node.js
- **@kubernetes/client-node 1.4.0**: Official Kubernetes client library for Node.js
- **axios 1.13.2**: Promise-based HTTP client for API requests
- **helmet 8.1.0**: Security middleware for Express
- **morgan 1.10.1**: HTTP request logger middleware
- **cors 2.8.5**: Cross-origin resource sharing middleware
- **dotenv 17.2.3**: Environment variable management

### Infrastructure

- **Kubernetes**: Container orchestration platform
- **Helm 3+**: Package manager for Kubernetes applications
- **Docker**: Containerization platform
- **kubectl**: Command-line tool for Kubernetes cluster management

### CI/CD

- **GitHub Actions**: Automated workflow platform
  - 8 application-specific build and deploy workflows
  - Helm lint workflow for chart validation
  - Rollback workflow for reverting deployments

### Monitoring and Observability

- **Prometheus**: Metrics collection and monitoring
- **Grafana**: Visualization dashboards for metrics
- **Loki**: Centralized log aggregation
- **Jaeger**: Distributed tracing across microservices

### Databases

- **PostgreSQL**: Relational database (managed via Helm chart)
- **Redis**: In-memory data store (managed via Helm chart)

### Development Tools

- **ESLint 9.39.1**: Linting utility for code quality
- **eslint-plugin-react-hooks 7.0.1**: React Hooks rules for ESLint
- **eslint-plugin-react-refresh 0.4.24**: React Fast Refresh support
- **npm**: Package manager for JavaScript dependencies

## Coding Standards

### Syntax Rules

- Use modern ES2020+ JavaScript syntax including async/await, arrow functions, and destructuring
- Frontend code uses ES modules (type: "module")
- Backend API uses CommonJS modules (require/module.exports)
- Use JSX for React components with .jsx extension

### Style Guidelines

- Follow ESLint recommended configuration
- Enforce React hooks rules via eslint-plugin-react-hooks
- No unused variables except for uppercase/constant patterns (varsIgnorePattern: '^[A-Z_]')
- Use single quotes for strings in configuration files
- Maintain consistent indentation (2 spaces)

### Naming Conventions

- **React Components**: PascalCase (e.g., Applications, Pipelines, Analytics)
- **Component Files**: PascalCase.jsx naming (e.g., Applications.jsx)
- **Route Handlers and Services**: camelCase
- **Configuration Files**: kebab-case
- **Environment Variables**: SCREAMING_SNAKE_CASE

### Architecture Principles

- **Component-Based Architecture**: React frontend organized into reusable components
- **Express Middleware Pattern**: Backend services follow Express middleware conventions
- **Separation of Concerns**: Organize code into routes, services, config, and utils
- **Health Check Endpoints**: All services must expose /health endpoint
- **Centralized Error Handling**: Use middleware for consistent error handling

### Security Requirements

- Use helmet middleware for security headers
- Enable CORS for cross-origin requests
- Store sensitive data in environment variables via dotenv
- **Never commit .env files to version control**
- Use RBAC (Role-Based Access Control) for Kubernetes service accounts
- Implement automated vulnerability scanning in CI pipeline

### Infrastructure Standards

- All infrastructure must be defined as code using Helm charts
- Use semantic versioning for all releases
- Implement immutable infrastructure - never modify running containers
- All deployments must include health checks and readiness probes
- Support horizontal pod autoscaling (HPA) for production workloads

### GitOps Principles

- Declarative infrastructure and application management
- Git as single source of truth
- Automated sync service monitors repository for changes
- Auto-rollback on failed deployments when enabled
- Dry-run mode support for testing changes

### Testing Standards

- Automated tests must run before every deployment
- Helm charts must pass linting via helm lint
- Post-deployment health checks validate successful rollouts

### Documentation Requirements

- README files required in major directories
- Helm charts include Chart.yaml with description and version
- API endpoints documented in route handlers
- Configuration files use inline YAML comments

## Project Structure

```
.
├── api
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── .env
│   ├── package.json
│   ├── package-lock.json
│   └── src
│       ├── config
│       ├── routes
│       ├── server.js
│       ├── services
│       └── utils
├── .artiforge
│   └── report.md
├── config
├── dashboard
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── eslint.config.js
│   ├── .gitignore
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   ├── public
│   │   └── vite.svg
│   ├── README.md
│   ├── src
│   │   ├── App.css
│   │   ├── App.jsx
│   │   ├── assets
│   │   ├── components
│   │   ├── index.css
│   │   ├── main.jsx
│   │   ├── pages
│   │   └── services
│   └── vite.config.js
├── docs
├── .github
│   └── workflows
│       ├── build-and-deploy-bookmarked.yml
│       ├── build-and-deploy-code-talk.yml
│       ├── build-and-deploy-educationelly-graphql.yml
│       ├── build-and-deploy-educationelly.yml
│       ├── build-and-deploy-firebook.yml
│       ├── build-and-deploy-intervalai.yml
│       ├── helm-lint.yml
│       └── rollback.yml
├── .gitignore
├── gitops
│   ├── applications
│   │   ├── bookmarked.yaml
│   │   ├── code-talk.yaml
│   │   ├── educationelly-graphql.yaml
│   │   ├── educationelly.yaml
│   │   ├── firebook.yaml
│   │   └── intervalai.yaml
│   └── sync-service
│       ├── config.yaml
│       ├── deployment.yaml
│       ├── Dockerfile
│       ├── .dockerignore
│       ├── package.json
│       ├── README.md
│       └── sync.js
├── helm-charts
│   ├── bookmarked
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── code-talk
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── educationelly
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── educationelly-graphql
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── firebook
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── intervalai
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── postgresql
│   │   ├── Chart.yaml
│   │   ├── templates
│   │   └── values.yaml
│   ├── README.md
│   └── redis
│       ├── Chart.yaml
│       ├── templates
│       └── values.yaml
├── k8s
│   ├── deployments
│   │   ├── api-deployment.yaml
│   │   └── dashboard-deployment.yaml
│   └── external-secrets
│       ├── external-secrets
│       ├── install.yaml
│       ├── QUICKSTART.md
│       ├── README.md
│       └── stores
├── README.md
└── scripts
    └── generate-templates.sh
```

### Directory Descriptions

- **api/**: Express backend API service
  - Integrates with Kubernetes, Helm, GitHub, and Prometheus APIs
  - Provides REST endpoints for dashboard
  - Health check and monitoring endpoints

- **dashboard/**: React frontend application
  - Named "PodRick" - management interface
  - Pages: Applications, CI/CD Pipelines, Analytics
  - Built with Vite for fast development and optimized production builds

- **gitops/**: GitOps workflow configuration
  - **applications/**: YAML manifests for each managed application
  - **sync-service/**: Automated synchronization service
    - Monitors Git repository for changes
    - Applies Helm releases automatically
    - Handles health checks and rollbacks

- **helm-charts/**: Helm charts for all applications
  - Each application has its own chart directory
  - Includes PostgreSQL and Redis charts for dependencies
  - Chart templates define Kubernetes resources (Deployments, Services, Ingress, etc.)

- **.github/workflows/**: CI/CD pipeline definitions
  - Application-specific build and deploy workflows
  - Helm lint workflow for chart validation
  - Rollback workflow for reverting deployments

- **k8s/**: Additional Kubernetes configurations
  - **deployments/**: Deployment manifests for API and dashboard
  - **external-secrets/**: External Secrets Operator configuration

- **scripts/**: Utility scripts for common operations
- **config/**: Environment-specific configuration files
- **docs/**: Project documentation

## External Resources

### Documentation

- **Kubernetes Documentation**: https://kubernetes.io/docs/
  - Official Kubernetes documentation for container orchestration

- **Helm Documentation**: https://helm.sh/docs/
  - Guide for Kubernetes package management with Helm

- **Docker Documentation**: https://docs.docker.com/
  - Container platform documentation

- **React Documentation**: https://react.dev/
  - Official React library documentation

- **Express.js Documentation**: https://expressjs.com/
  - Web framework for Node.js

- **GitHub Actions Documentation**: https://docs.github.com/en/actions
  - CI/CD automation platform documentation

- **Vite Documentation**: https://vite.dev/
  - Build tool and development server documentation

### External Services

#### Docker Hub
- **URL**: https://hub.docker.com/
- **Category**: Container Registry
- **Purpose**: Container image registry for storing and distributing Docker images
- **Authentication**: DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets configured in GitHub

#### GitHub Actions
- **URL**: https://github.com/features/actions
- **Category**: CI/CD Platform
- **Purpose**: Automated build, test, and deployment workflows
- **Configuration**: 8 workflow files for applications plus helm-lint and rollback workflows

#### Kubernetes Cluster
- **Category**: Infrastructure
- **Purpose**: Container orchestration platform running all portfolio applications
- **Access**: KUBECONFIG secret for kubectl access from CI/CD pipelines

### Key Libraries

#### @kubernetes/client-node
- **URL**: https://github.com/kubernetes-client/javascript
- **Purpose**: Official Kubernetes client library for Node.js
- **Usage**: API backend communicates with Kubernetes cluster for deployment status and management

#### axios
- **URL**: https://axios-http.com/
- **Purpose**: Promise-based HTTP client for browser and Node.js
- **Usage**: API makes HTTP requests to Prometheus, GitHub API, and other external services

#### helmet
- **URL**: https://helmetjs.github.io/
- **Purpose**: Express middleware for setting security-related HTTP headers
- **Usage**: Protects API from common web vulnerabilities

#### js-yaml
- **URL**: https://github.com/nodeca/js-yaml
- **Purpose**: YAML parser and dumper for JavaScript
- **Usage**: GitOps sync service parses Helm values and application manifests

### Development Tools

#### kubectl
- **URL**: https://kubernetes.io/docs/reference/kubectl/
- **Purpose**: Command-line tool for interacting with Kubernetes clusters
- **Usage**: Deployment scripts and GitOps service use kubectl for cluster operations

#### helm
- **URL**: https://helm.sh/
- **Purpose**: Package manager for Kubernetes applications
- **Usage**: Manages installation and upgrades of all portfolio applications via charts

#### ESLint
- **URL**: https://eslint.org/
- **Purpose**: Pluggable linting utility for JavaScript and JSX
- **Usage**: Enforces code quality and consistency in dashboard React application

## Development Workflow

The platform follows a push-to-deploy workflow:

1. **Developer pushes code changes** to GitHub repository
2. **GitHub Actions workflow triggers** automatically
3. **Code is linted and tested** to ensure quality
4. **Docker image is built** and tagged with commit SHA
5. **Image is pushed** to Docker Hub registry
6. **Helm values are updated** with new image tag
7. **Application is deployed** to Kubernetes cluster
8. **Health checks validate** successful deployment
9. **If deployment fails**, automatic rollback occurs (when enabled)

## Key Features

### Automated Synchronization
- GitOps service polls repository every 60 seconds for changes
- Detects new commits and triggers automated deployments
- Ensures cluster state matches Git repository state

### Helm Release Management
- Automatic installation of new Helm releases
- Seamless upgrades of existing releases
- Version tracking and release history

### Health Validation
- Post-deployment health checks ensure applications are running correctly
- Kubernetes readiness and liveness probes
- Deployment status validation before marking release as successful

### Rollback Capabilities
- **One-command rollback**: Revert to previous versions manually
- **Automatic rollback**: On deployment failure when enabled
- **Release history**: View all previous deployments with `helm history`

### Multi-Environment Support
- Environment-specific configurations for dev/staging/production
- Value overrides for different deployment targets
- Separate configuration files per environment

### Security Features
- **RBAC**: Role-based access control for service accounts
- **Secrets Management**: Kubernetes secrets for sensitive data
- **Network Policies**: Pod-to-pod communication restrictions
- **Vulnerability Scanning**: Automated security scanning in CI pipeline

## Dashboard Frontend

React-based dashboard named **"PodRick"** provides comprehensive management interface:

### Pages

1. **Applications**: View and manage all portfolio applications
   - Application status and health
   - Deployment information
   - Resource utilization

2. **CI/CD Pipelines**: Monitor GitHub Actions workflows
   - Workflow run status
   - Build and deployment logs
   - Trigger manual deployments

3. **Analytics**: Visualize metrics and performance data
   - Prometheus metrics integration
   - Grafana dashboard embedding
   - Performance trends and insights

## API Backend

Express.js API provides integration with multiple systems:

### API Routes

- **/api/argocd**: ArgoCD GitOps application management
- **/api/prometheus**: Metrics and monitoring data
- **/api/github**: GitHub workflow and repository information
- **/api/helm**: Helm release management and deployment status
- **/api/applications**: Application state and health information

### Middleware Stack

1. **helmet**: Security headers
2. **cors**: Cross-origin resource sharing
3. **morgan**: HTTP request logging
4. **express.json()**: JSON body parsing
5. **Error handler**: Centralized error handling

## GitOps Sync Service

Standalone Node.js service that implements GitOps automation:

### Features

- **Repository Monitoring**: Continuously watches Git repository for changes
- **Automatic Deployment**: Applies Helm charts when changes detected
- **Health Checking**: Validates deployments are successful
- **Rollback Logic**: Automatically reverts failed deployments
- **Dry-run Mode**: Test changes without applying them
- **Configurable Interval**: Adjustable sync frequency

### Configuration

The sync service is configured via `gitops/sync-service/config.yaml`:

- Sync interval (default: 60 seconds)
- Git repository and branch to monitor
- List of applications to manage
- Auto-rollback settings
- Health check parameters

## Best Practices Implemented

1. **Immutable Infrastructure**: Always deploy new versions, never modify running containers
2. **Semantic Versioning**: All releases follow semver conventions (MAJOR.MINOR.PATCH)
3. **Blue-Green Deployments**: Zero-downtime deployments with gradual rollout
4. **Automated Testing**: Tests run before every deployment in CI pipeline
5. **Infrastructure as Code**: All configuration in version control
6. **Declarative Configuration**: Desired state defined in Git, actual state matches desired state
7. **Continuous Reconciliation**: Sync service ensures cluster state matches Git repository
8. **Observability**: Comprehensive monitoring with Prometheus, Grafana, Loki, and Jaeger

## Security Considerations

### Secrets Management
- Environment variables stored in .env files (not committed to Git)
- GitHub secrets manage sensitive credentials (DOCKERHUB_TOKEN, KUBECONFIG)
- Kubernetes secrets for application credentials and API keys

### API Security
- Helmet middleware sets security headers on API responses
- CORS configured to allow cross-origin requests from dashboard
- Input validation and sanitization

### Kubernetes Security
- RBAC policies restrict service account permissions
- Network policies control pod-to-pod communication
- Pod security policies enforce container restrictions

### CI/CD Security
- Automated image scanning detects vulnerabilities
- Dependency scanning for package vulnerabilities
- Secret scanning prevents credential leaks

## Monitoring and Observability

### Prometheus Integration
- ServiceMonitor configurations in Helm charts
- Automatic metrics collection from all applications
- Custom metrics for business logic

### Grafana Dashboards
- Pre-configured dashboards for each application
- Infrastructure and cluster-level metrics
- Custom alerts and notifications

### Logging with Loki
- Centralized log aggregation
- Log querying and filtering
- Integration with Grafana for log visualization

### Distributed Tracing with Jaeger
- Request tracing across microservices
- Performance bottleneck identification
- Dependency mapping

### Health Checks
- Health check endpoints on all services (/health)
- Kubernetes readiness and liveness probes
- Morgan middleware logs HTTP requests in API

## Build Steps

### Prerequisites

- kubectl configured with cluster access
- Helm 3+ installed
- Docker installed
- GitHub repository with Actions enabled
- Node.js (latest LTS version)

### Building the Dashboard

```bash
cd dashboard
npm install
npm run build
```

### Building the API

```bash
cd api
npm install
npm start
```

### Building the GitOps Sync Service

```bash
cd gitops/sync-service
npm install
npm start
```

### Building Docker Images

```bash
# Dashboard
cd dashboard
docker build -t your-registry/dashboard:tag .

# API
cd api
docker build -t your-registry/api:tag .

# GitOps Sync Service
cd gitops/sync-service
docker build -t your-registry/gitops-sync:tag .
```

### Deploying to Kubernetes

```bash
# Deploy a single application
cd helm-charts/intervalai
helm install intervalai . -n default

# Deploy with custom values
helm install intervalai . -f values-production.yaml -n default

# Upgrade existing release
helm upgrade intervalai . -n default
```

## Testing Instructions

### Linting

```bash
# Dashboard linting
cd dashboard
npm run lint

# Helm chart linting
helm lint helm-charts/intervalai
```

### Running Tests

```bash
# API tests (when implemented)
cd api
npm test

# Dashboard tests (when implemented)
cd dashboard
npm test
```

### Manual Testing

1. **Health Check**: Verify service health endpoints
   ```bash
   curl http://localhost:5001/health
   ```

2. **Deployment Validation**: Check Kubernetes deployment status
   ```bash
   kubectl get deployments -n default
   kubectl get pods -n default
   ```

3. **Helm Release Status**: Verify Helm release status
   ```bash
   helm status intervalai -n default
   helm history intervalai -n default
   ```

## CI/CD Configuration

### GitHub Secrets Required

Set these secrets in your GitHub repository:

- **DOCKERHUB_USERNAME**: Docker Hub username for image push
- **DOCKERHUB_TOKEN**: Docker Hub access token
- **KUBECONFIG**: Base64-encoded kubeconfig file for cluster access

```bash
# Set secrets using GitHub CLI
gh secret set DOCKERHUB_USERNAME --body "your-username"
gh secret set DOCKERHUB_TOKEN --body "your-token"
gh secret set KUBECONFIG --body "$(cat ~/.kube/config | base64)"
```

### Triggering Workflows

#### Automatic Trigger
Push changes to main branch to trigger automatic deployment:
```bash
git add .
git commit -m "Deploy updates"
git push origin main
```

#### Manual Trigger
Trigger workflow manually with specific parameters:
```bash
gh workflow run build-and-deploy-intervalai.yml -f version=v1.2.3
```

## Rollback Procedures

### Manual Rollback

```bash
# Rollback to previous version
helm rollback intervalai -n default

# Rollback to specific revision
helm rollback intervalai 2 -n default

# View rollout history
helm history intervalai -n default
```

### Automatic Rollback

Automatic rollback is configured in the GitOps sync service:
- Enabled via `sync.autoRollback` in config.yaml
- Triggers when deployment health checks fail
- Reverts to last known good release

## Troubleshooting

### Deployment Issues

```bash
# Check deployment status
kubectl get deployments -n default
kubectl describe deployment intervalai -n default

# View pod logs
kubectl logs -n default -l app=intervalai --tail=100

# Check Helm release status
helm status intervalai -n default
```

### GitOps Sync Issues

```bash
# Check sync service logs
kubectl logs -n default -l app=gitops-sync

# Manually trigger sync
kubectl exec -n default gitops-sync-pod -- node sync.js
```

### Common Issues

1. **Image Pull Errors**: Verify Docker Hub credentials in secrets
2. **Health Check Failures**: Check application logs and readiness probes
3. **Helm Chart Errors**: Validate chart with `helm lint`
4. **Sync Service Not Running**: Check sync service logs and configuration

## Project Status

- **Status**: Active development and maintenance
- **Environment**: Production-ready platform
- **Applications Managed**: 6 portfolio applications
- **CI/CD**: Fully automated with GitHub Actions
- **Deployment Model**: GitOps with automated synchronization
- **Infrastructure**: Comprehensive Helm charts for all components

---

*This documentation is intended for AI agents working with the DevOps Portfolio Manager project. For user-facing documentation, see README.md.*
