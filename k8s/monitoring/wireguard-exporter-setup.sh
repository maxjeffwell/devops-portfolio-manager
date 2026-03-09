#!/usr/bin/env bash
# Install prometheus_wireguard_exporter (MindFlavor) as a systemd service
# Extracts the static binary from the Docker image, then runs natively
# Run on each K3s node: vmi2951245, vmi3115606, marmoset
set -euo pipefail

EXPORTER_VERSION="3.6.6"
IMAGE="mindflavor/prometheus-wireguard-exporter:${EXPORTER_VERSION}"
INSTALL_DIR="/usr/local/bin"
LISTEN_PORT="9586"

echo "=== Installing prometheus_wireguard_exporter v${EXPORTER_VERSION} ==="

# Stop existing service if running
systemctl stop prometheus-wireguard-exporter.service 2>/dev/null || true

# Extract static binary from Docker image
echo "Extracting binary from ${IMAGE}..."
docker pull "${IMAGE}" --quiet
CONTAINER_ID=$(docker create "${IMAGE}")
docker cp "${CONTAINER_ID}:/usr/local/bin/prometheus_wireguard_exporter" "${INSTALL_DIR}/prometheus_wireguard_exporter"
docker rm "${CONTAINER_ID}" >/dev/null
chmod +x "${INSTALL_DIR}/prometheus_wireguard_exporter"

echo "Binary installed: $(file ${INSTALL_DIR}/prometheus_wireguard_exporter | cut -d: -f2)"

# Remove Docker-based service container if it exists
docker rm -f prometheus-wireguard-exporter 2>/dev/null || true

# Create systemd service (native binary, no Docker)
cat > /etc/systemd/system/prometheus-wireguard-exporter.service <<EOF
[Unit]
Description=Prometheus WireGuard Exporter
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/prometheus_wireguard_exporter -p ${LISTEN_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable --now prometheus-wireguard-exporter.service

echo "=== Verifying ==="
sleep 2
if systemctl is-active --quiet prometheus-wireguard-exporter; then
  echo "Service is running on port ${LISTEN_PORT}"
  METRIC_COUNT=$(curl -s "http://localhost:${LISTEN_PORT}/metrics" | grep -c "wireguard_" || true)
  echo "${METRIC_COUNT} wireguard metric(s) found"
else
  echo "Service failed to start. Check: journalctl -u prometheus-wireguard-exporter -n 20"
  exit 1
fi

echo "=== Done ==="
