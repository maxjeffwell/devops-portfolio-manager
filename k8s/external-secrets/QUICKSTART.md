# External Secrets Quick Start Guide

This guide walks you through setting up External Secrets Operator for your portfolio applications.

## Prerequisites

- Kubernetes cluster (MicroK8s, EKS, GKE, AKS, etc.)
- kubectl configured to access your cluster
- Helm 3.x (optional, for easier installation)
- Cloud credentials for your chosen secret backend

## Step 1: Install External Secrets Operator

### Using Helm (Recommended)

```bash
# Add repository
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

# Install operator
helm install external-secrets \
  external-secrets/external-secrets \
  -n external-secrets-system \
  --create-namespace \
  --set installCRDs=true

# Verify installation
kubectl get pods -n external-secrets-system
```

### Using kubectl

```bash
# Install from this repository
kubectl apply -f k8s/external-secrets/install.yaml

# Or install from upstream
kubectl apply -f https://raw.githubusercontent.com/external-secrets/external-secrets/main/deploy/crds/bundle.yaml
```

## Step 2: Choose and Configure Secret Backend

Select one of the following backends based on where your applications are hosted:

### Option A: AWS Secrets Manager

**1. Create secrets in AWS Secrets Manager:**

```bash
# Store database URLs
aws secretsmanager create-secret \
  --name portfolio/bookmarked/database-url \
  --secret-string "postgresql://user:pass@rds-endpoint:5432/bookmarked"

aws secretsmanager create-secret \
  --name portfolio/code-talk/database-url \
  --secret-string "postgresql://user:pass@rds-endpoint:5432/codetalk"

aws secretsmanager create-secret \
  --name portfolio/code-talk/redis-url \
  --secret-string "redis://user:pass@redis-endpoint:6379"

# MongoDB Atlas URIs
aws secretsmanager create-secret \
  --name portfolio/educationelly/mongodb-uri \
  --secret-string "mongodb+srv://user:pass@cluster.mongodb.net/educationelly"

aws secretsmanager create-secret \
  --name portfolio/intervalai/mongodb-uri \
  --secret-string "mongodb+srv://user:pass@cluster.mongodb.net/intervalai"

# JWT Secrets
aws secretsmanager create-secret \
  --name portfolio/bookmarked/jwt-secret \
  --secret-string "your-random-jwt-secret-here"
```

**2. Create AWS credentials in Kubernetes:**

```bash
kubectl create secret generic aws-credentials \
  --from-literal=access-key-id=AKIAIOSFODNN7EXAMPLE \
  --from-literal=secret-access-key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  -n default
```

**3. Apply SecretStore:**

```bash
kubectl apply -f k8s/external-secrets/stores/aws-secretstore.yaml
```

### Option B: Google Secret Manager

**1. Create secrets in Google Secret Manager:**

```bash
# Enable Secret Manager API
gcloud services enable secretmanager.googleapis.com

# Store secrets
echo -n "postgresql://user:pass@host:5432/bookmarked" | \
  gcloud secrets create portfolio-bookmarked-database-url --data-file=-

echo -n "mongodb+srv://user:pass@cluster.mongodb.net/intervalai" | \
  gcloud secrets create portfolio-intervalai-mongodb-uri --data-file=-
```

**2. Create service account and key:**

```bash
# Create service account
gcloud iam service-accounts create external-secrets-sa

# Grant permissions
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:external-secrets-sa@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Create key
gcloud iam service-accounts keys create credentials.json \
  --iam-account=external-secrets-sa@PROJECT_ID.iam.gserviceaccount.com

# Create Kubernetes secret
kubectl create secret generic gcp-credentials \
  --from-file=credentials.json=./credentials.json \
  -n default
```

**3. Apply SecretStore:**

```bash
# Edit the YAML to set your project ID
kubectl apply -f k8s/external-secrets/stores/gcp-secretstore.yaml
```

### Option C: HashiCorp Vault

**1. Enable Kubernetes auth in Vault:**

```bash
vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://$KUBERNETES_PORT_443_TCP_ADDR:443"
```

**2. Create secrets in Vault:**

```bash
vault kv put secret/portfolio/bookmarked/database-url value="postgresql://..."
vault kv put secret/portfolio/bookmarked/jwt-secret value="your-secret"
```

**3. Create policy and role:**

```bash
vault policy write external-secrets - <<EOF
path "secret/data/portfolio/*" {
  capabilities = ["read"]
}
EOF

vault write auth/kubernetes/role/external-secrets-role \
  bound_service_account_names=external-secrets-sa \
  bound_service_account_namespaces=default \
  policies=external-secrets \
  ttl=24h
```

**4. Apply SecretStore:**

```bash
kubectl apply -f k8s/external-secrets/stores/vault-secretstore.yaml
```

## Step 3: Apply ExternalSecrets

Apply the ExternalSecret resources for your applications:

```bash
# Apply all ExternalSecrets
kubectl apply -f k8s/external-secrets/external-secrets/

# Or apply individually
kubectl apply -f k8s/external-secrets/external-secrets/bookmarked-externalsecret.yaml
kubectl apply -f k8s/external-secrets/external-secrets/code-talk-externalsecret.yaml
kubectl apply -f k8s/external-secrets/external-secrets/educationelly-externalsecret.yaml
kubectl apply -f k8s/external-secrets/external-secrets/educationelly-graphql-externalsecret.yaml
kubectl apply -f k8s/external-secrets/external-secrets/intervalai-externalsecret.yaml
```

## Step 4: Verify Secret Sync

Check that secrets are syncing correctly:

```bash
# Check ExternalSecret status
kubectl get externalsecrets
# Should show READY STATUS: SecretSynced

# Verify Kubernetes secrets were created
kubectl get secrets | grep -E "(bookmarked|code-talk|educationelly|intervalai)"

# View secret details (values are base64 encoded)
kubectl get secret bookmarked-secret -o yaml

# Decode a secret value
kubectl get secret bookmarked-secret -o jsonpath='{.data.DATABASE_URL}' | base64 -d
```

## Step 5: Deploy Applications

Now deploy your applications using Helm:

```bash
# Deploy Bookmarked
helm install bookmarked ./helm-charts/bookmarked

# Deploy Code Talk
helm install code-talk ./helm-charts/code-talk

# Deploy EducationELLy
helm install educationelly ./helm-charts/educationelly

# Deploy EducationELLy GraphQL
helm install educationelly-graphql ./helm-charts/educationelly-graphql

# Deploy IntervalAI (disable in-cluster MongoDB)
helm install intervalai ./helm-charts/intervalai \
  --set mongodb.enabled=false
```

## Troubleshooting

### ExternalSecret shows "SecretSyncedError"

```bash
# Check ExternalSecret details
kubectl describe externalsecret bookmarked-externalsecret

# Check operator logs
kubectl logs -n external-secrets-system \
  -l app.kubernetes.io/name=external-secrets --tail=100
```

Common issues:
- **Invalid credentials**: Check that the SecretStore authentication credentials are correct
- **Permission denied**: Ensure the service account/IAM role has access to read secrets
- **Secret not found**: Verify the secret exists in the external store with the exact key path
- **Network issues**: Check that the cluster can reach the external secret store

### Secrets not updating

ExternalSecrets refresh based on the `refreshInterval` (default: 1h). To force immediate refresh:

```bash
# Delete and recreate the ExternalSecret
kubectl delete externalsecret bookmarked-externalsecret
kubectl apply -f k8s/external-secrets/external-secrets/bookmarked-externalsecret.yaml

# Or annotate to trigger refresh
kubectl annotate externalsecret bookmarked-externalsecret \
  force-sync=$(date +%s) --overwrite
```

### Pod not using updated secrets

Kubernetes doesn't automatically restart pods when secrets change. You must:

```bash
# Rollout restart the deployment
kubectl rollout restart deployment/bookmarked-server
kubectl rollout restart deployment/bookmarked-client

# Or use a tool like Reloader to automate this
```

## Security Best Practices

1. **Use IAM roles/managed identities** instead of static credentials when possible
2. **Enable audit logging** on your secret backend
3. **Use separate secrets** for dev/staging/production environments
4. **Rotate secrets regularly** and update them in the external store
5. **Limit access** to ExternalSecret and SecretStore resources using RBAC
6. **Monitor** for unauthorized secret access in your cloud provider logs

## Next Steps

- Set up automated secret rotation
- Configure secret monitoring and alerting
- Implement secret versioning
- Add secrets for additional environments (staging, dev)
- Integrate with CI/CD pipelines

## Resources

- [External Secrets Operator Documentation](https://external-secrets.io/)
- [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/)
- [Google Secret Manager](https://cloud.google.com/secret-manager)
- [Azure Key Vault](https://azure.microsoft.com/en-us/services/key-vault/)
- [HashiCorp Vault](https://www.vaultproject.io/)
