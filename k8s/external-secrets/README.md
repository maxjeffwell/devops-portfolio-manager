# External Secrets Operator Setup

External Secrets Operator (ESO) syncs secrets from external secret stores into Kubernetes Secrets. This setup supports multiple backends including AWS Secrets Manager, Azure Key Vault, Google Secret Manager, HashiCorp Vault, and generic webhook providers.

## Installation

### Option 1: Helm (Recommended)

```bash
# Add the External Secrets Operator Helm repository
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

# Install External Secrets Operator
helm install external-secrets \
  external-secrets/external-secrets \
  -n external-secrets-system \
  --create-namespace \
  --set installCRDs=true
```

### Option 2: kubectl

```bash
# Install CRDs
kubectl apply -f https://raw.githubusercontent.com/external-secrets/external-secrets/main/deploy/crds/bundle.yaml

# Install operator
kubectl apply -f install.yaml
```

### Verify Installation

```bash
# Check operator pods
kubectl get pods -n external-secrets-system

# Check CRDs
kubectl get crd | grep external-secrets
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    External Secret Stores                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ AWS Secrets  │  │ MongoDB      │  │ Redis        │  │
│  │ Manager      │  │ Atlas        │  │ Cloud        │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   SecretStore CRD    │
              │  (per namespace or   │
              │   cluster-wide)      │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  ExternalSecret CRD  │
              │  (defines what to    │
              │   sync and where)    │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Kubernetes Secret  │
              │  (synced by ESO)     │
              └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Application Pods   │
              │  (use synced secrets)│
              └──────────────────────┘
```

## Configuration

### 1. Create SecretStore

A SecretStore defines the connection to an external secret backend. Choose the appropriate store for your setup:

- **AWS Secrets Manager**: `stores/aws-secretstore.yaml`
- **Google Secret Manager**: `stores/gcp-secretstore.yaml`
- **Azure Key Vault**: `stores/azure-secretstore.yaml`
- **Generic Webhook**: `stores/webhook-secretstore.yaml`
- **HashiCorp Vault**: `stores/vault-secretstore.yaml`

### 2. Create Bootstrap Secrets

Some SecretStores require authentication credentials. Create these manually once:

```bash
# AWS Example
kubectl create secret generic aws-credentials \
  --from-literal=access-key-id=YOUR_ACCESS_KEY \
  --from-literal=secret-access-key=YOUR_SECRET_KEY \
  -n default

# MongoDB Atlas API Key Example
kubectl create secret generic mongodb-atlas-api-key \
  --from-literal=public-key=YOUR_PUBLIC_KEY \
  --from-literal=private-key=YOUR_PRIVATE_KEY \
  -n default
```

### 3. Create ExternalSecrets

ExternalSecret resources define which secrets to sync from the external store:

```bash
kubectl apply -f external-secrets/bookmarked-externalsecret.yaml
kubectl apply -f external-secrets/code-talk-externalsecret.yaml
# ... etc for each application
```

### 4. Verify Secret Sync

```bash
# Check ExternalSecret status
kubectl get externalsecrets

# Verify synced secrets
kubectl get secrets | grep -E "(bookmarked|code-talk|educationelly|firebook|intervalai)"

# Describe an ExternalSecret for details
kubectl describe externalsecret bookmarked-secret
```

## Application Integration

Applications automatically use the synced secrets via environment variables:

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: bookmarked-secret  # Created by ExternalSecret
        key: DATABASE_URL
```

## Supported Secret Stores

### AWS Secrets Manager
- Best for: AWS-hosted infrastructure
- Authentication: IAM roles, access keys
- Cost: $0.40/secret/month + $0.05/10k API calls

### Google Secret Manager
- Best for: GCP-hosted infrastructure
- Authentication: Service accounts, workload identity
- Cost: $0.06/secret/month + $0.03/10k API calls

### Azure Key Vault
- Best for: Azure-hosted infrastructure
- Authentication: Managed identities, service principals
- Cost: $0.03/10k operations

### MongoDB Atlas (via Webhook)
- Best for: MongoDB connection strings
- Authentication: API keys
- Cost: Free (included with MongoDB Atlas)

### Redis Cloud (via Generic Provider)
- Best for: Redis connection strings
- Authentication: API keys
- Cost: Free (included with Redis Cloud)

### HashiCorp Vault
- Best for: Self-hosted secrets management
- Authentication: Kubernetes auth, tokens
- Cost: Free (self-hosted) or paid (HCP Vault)

## Security Best Practices

1. **Least Privilege**: Grant minimal permissions to SecretStore authentication credentials
2. **Rotation**: Regularly rotate SecretStore authentication credentials
3. **Audit**: Enable audit logging on external secret stores
4. **Encryption**: Ensure external secret stores use encryption at rest
5. **Network**: Restrict network access to secret stores using security groups/firewalls
6. **RBAC**: Use Kubernetes RBAC to control access to ExternalSecret and SecretStore resources

## Troubleshooting

### ExternalSecret not syncing

```bash
# Check ExternalSecret status
kubectl describe externalsecret <name>

# Check operator logs
kubectl logs -n external-secrets-system -l app.kubernetes.io/name=external-secrets

# Verify SecretStore is ready
kubectl get secretstore
```

### Authentication errors

```bash
# Verify bootstrap secret exists
kubectl get secret <auth-secret-name> -o yaml

# Check SecretStore status
kubectl describe secretstore <store-name>
```

### Secret not available to pods

```bash
# Verify secret was created
kubectl get secret <secret-name>

# Check secret contents (base64 encoded)
kubectl get secret <secret-name> -o jsonpath='{.data}'

# Describe pod to see if secret is mounted
kubectl describe pod <pod-name>
```

## Automation with Helm Charts

The application Helm charts support automatic ExternalSecret creation:

```yaml
# values.yaml
externalSecrets:
  enabled: true
  storeName: aws-secretstore
  secretKeys:
    - name: DATABASE_URL
      key: portfolio/bookmarked/database-url
    - name: JWT_SECRET
      key: portfolio/bookmarked/jwt-secret
```

See individual application chart documentation for details.
