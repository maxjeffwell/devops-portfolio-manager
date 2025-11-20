FROM node:18-alpine

# Install git, helm, and kubectl
RUN apk add --no-cache \
    git \
    curl \
    bash \
    && curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/ \
    && curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY sync.js ./
COPY config.yaml ./

# Make sync.js executable
RUN chmod +x sync.js

# Create directory for repository cloning
RUN mkdir -p /tmp/gitops-repo

# Run as non-root user
USER node

# Start the sync service
CMD ["node", "sync.js"]
