# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
# Force rebuild with basename fix - 2025-12-09
RUN npm run build

# Production stage
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html/devops

# Create nginx config
RUN echo 'server { \
    listen 80; \
    server_name podrick.el-jefe.me; \
    root /usr/share/nginx/html/devops; \
    location / { \
    index index.html; \
    try_files $uri $uri/ /index.html; \
    } \
    } \
    server { \
    listen 80 default_server; \
    root /usr/share/nginx/html; \
    location / { \
    index index.html; \
    try_files $uri $uri/ /index.html; \
    } \
    location /devops/ { \
    index index.html; \
    try_files $uri $uri/ /devops/index.html; \
    } \
    }' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
