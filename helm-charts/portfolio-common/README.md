# Portfolio Common Library Chart

A Helm library chart containing common, reusable templates for portfolio applications.

## Purpose

This library chart eliminates code duplication across application Helm charts by providing reusable templates for common Kubernetes resources.

## Usage

### Add as Dependency

Add to your application's `Chart.yaml`:

```yaml
dependencies:
  - name: portfolio-common
    version: 1.0.0
    repository: "file://../portfolio-common"
```

### Use Templates

In your application chart templates:

#### Deployment

```yaml
# templates/deployment-server.yaml
{{- include "portfolio-common.deployment" (dict "component" "server" "context" $) }}
---
# templates/deployment-client.yaml
{{- include "portfolio-common.deployment" (dict "component" "client" "context" $) }}
```

#### Service

```yaml
# templates/service.yaml
{{- include "portfolio-common.service" (dict "component" "server" "context" $) }}
---
{{- include "portfolio-common.service" (dict "component" "client" "context" $) }}
```

#### Service Account

```yaml
# templates/serviceaccount.yaml
{{- include "portfolio-common.serviceAccount" . }}
```

#### HPA (Horizontal Pod Autoscaler)

```yaml
# templates/hpa.yaml
{{- include "portfolio-common.hpa" (dict "component" "server" "context" $) }}
```

#### Secret

```yaml
# templates/secret.yaml
{{- include "portfolio-common.secret" . }}
```

## Available Templates

- `portfolio-common.deployment` - Deployment template
- `portfolio-common.service` - Service template
- `portfolio-common.serviceAccount` - ServiceAccount template
- `portfolio-common.hpa` - HorizontalPodAutoscaler template
- `portfolio-common.secret` - Secret template
- `portfolio-common.labels` - Common labels
- `portfolio-common.selectorLabels` - Selector labels
- `portfolio-common.name` - Chart name helper
- `portfolio-common.fullname` - Full name helper
- `portfolio-common.serviceAccountName` - Service account name helper

## Expected Values Structure

```yaml
replicaCount: 2

image:
  server:
    repository: myregistry/app-server
    tag: latest
    pullPolicy: Always
  client:
    repository: myregistry/app-client
    tag: latest
    pullPolicy: Always

service:
  server:
    type: ClusterIP
    port: 8000
    targetPort: 8000
  client:
    type: NodePort
    port: 80
    targetPort: 80
    nodePort: 30002

resources:
  server:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 256Mi
  client:
    limits:
      cpu: 200m
      memory: 256Mi
    requests:
      cpu: 50m
      memory: 128Mi

env:
  server:
    - name: NODE_ENV
      value: "production"
  client:
    - name: REACT_APP_API_URL
      value: "http://app-server:8000"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 80

serviceAccount:
  create: true
  annotations: {}
  name: ""

podSecurityContext:
  fsGroup: 2000

securityContext:
  capabilities:
    drop:
    - ALL
  readOnlyRootFilesystem: false
  runAsNonRoot: true
  runAsUser: 1001
```

## Frontend-Only Applications

For frontend-only apps (like Firebase SPAs), use only the `client` component:

```yaml
image:
  client:
    repository: myregistry/app-client
    tag: latest
    pullPolicy: Always

service:
  client:
    type: NodePort
    port: 80
    targetPort: 80
    nodePort: 30004

resources:
  client:
    limits:
      cpu: 200m
      memory: 256Mi
    requests:
      cpu: 50m
      memory: 128Mi

env:
  client: []
```

## Benefits

- **DRY Principle**: Eliminates duplicate template code across charts
- **Consistency**: Ensures all applications follow the same patterns
- **Maintainability**: Updates to common templates apply to all charts
- **Reduced Complexity**: Application charts become much simpler
- **Best Practices**: Encapsulates Kubernetes best practices in one place
