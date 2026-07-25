#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_INFRA_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VALUES_DIR="${EXAMPLE_INFRA_DIR}/values"

echo "==================================================================="
echo " DEPLOYING OBSERVABILITY STACK AND OTEL-DEMO"
echo "==================================================================="

# 1. Create namespaces
echo -e "\n[1/5] Creating namespaces (observability, otel-demo)..."
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace otel-demo --dry-run=client -o yaml | kubectl apply -f -

# 2. Add and update Helm repositories
echo -e "\n[2/5] Configuring Helm repositories..."
helm repo add grafana https://grafana.github.io/helm-charts --force-update
helm repo add grafana-community https://grafana-community.github.io/helm-charts --force-update
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts --force-update
helm repo update

# 3. Deploy Observability stack
echo -e "\n[3/5] Deploying Observability components (Tempo, Loki, Promtail, Kube-Prometheus-Stack)..."

echo " -> Deploying Grafana Tempo..."
helm upgrade --install tempo grafana/tempo -n observability -f "${VALUES_DIR}/tempo-values.yaml"

echo " -> Deploying Grafana Loki..."
helm upgrade --install loki grafana/loki -n observability -f "${VALUES_DIR}/loki-values.yaml"

echo " -> Deploying Grafana Promtail..."
helm upgrade --install promtail grafana/promtail -n observability -f "${VALUES_DIR}/promtail-values.yaml"

echo " -> Deploying Prometheus & Grafana Stack..."
helm upgrade --install prom-stack prometheus-community/kube-prometheus-stack -n observability -f "${VALUES_DIR}/prom-values.yaml"

echo " -> Deploying Grafana MCP Server (read-only)..."
helm upgrade --install grafana-mcp grafana-community/grafana-mcp -n observability -f "${VALUES_DIR}/grafana-mcp-values.yaml"

# 4. Deploy OpenTelemetry Demo application
echo -e "\n[4/5] Deploying OpenTelemetry Demo e-commerce application..."
helm upgrade --install otel-demo open-telemetry/opentelemetry-demo -n otel-demo -f "${VALUES_DIR}/otel-demo-values.yaml"

# 4.5 Deploy custom thesis alerts
echo -e "\n[4.5/5] Deploying Custom Prometheus Alerts..."
kubectl apply -f "${EXAMPLE_INFRA_DIR}/alerts"

# 5. Start background port forwarding
echo -e "\n[5/5] Starting background port forwarding..."

chmod +x "${SCRIPT_DIR}/start-port-forwards.sh" || true
"${SCRIPT_DIR}/start-port-forwards.sh"

echo -e "\n==================================================================="
echo " DEPLOYMENT AND PORT FORWARDING COMPLETED SUCCESSFULLY!"
echo "==================================================================="
echo -e "\nActive port forwarding running in the background:"
echo "  1. Grafana (Observability UI):          http://localhost:8081  (admin / admin)"
echo "  2. OpenTelemetry Demo Store & UI:       http://localhost:8080"
echo "  3. Prometheus API:                      http://localhost:9090"
echo "  4. Alertmanager UI:                     http://localhost:9093"
echo ""
