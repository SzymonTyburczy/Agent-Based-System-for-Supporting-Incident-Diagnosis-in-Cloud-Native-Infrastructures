#!/usr/bin/env bash
set -euo pipefail

echo "Stopping any existing kubectl port-forward processes..."
pkill -f "kubectl port-forward" 2>/dev/null || true
sleep 1

echo "Starting resilient background port forwarding..."
nohup bash -c 'while true; do kubectl port-forward svc/frontend-proxy 8080:8080 -n otel-demo >/dev/null 2>&1; sleep 2; done' >/dev/null 2>&1 &
nohup bash -c 'while true; do kubectl port-forward svc/prom-stack-grafana 8081:80 -n observability >/dev/null 2>&1; sleep 2; done' >/dev/null 2>&1 &
nohup bash -c 'while true; do kubectl port-forward svc/prom-stack-kube-prometheus-prometheus 9090:9090 -n observability >/dev/null 2>&1; sleep 2; done' >/dev/null 2>&1 &
nohup bash -c 'while true; do kubectl port-forward svc/prom-stack-kube-prometheus-alertmanager 9093:9093 -n observability >/dev/null 2>&1; sleep 2; done' >/dev/null 2>&1 &
nohup bash -c 'while true; do kubectl port-forward svc/grafana-mcp 8000:8000 -n observability >/dev/null 2>&1; sleep 2; done' >/dev/null 2>&1 &

echo ""
echo "Active Port Forwards running in background:"
echo "  Grafana UI:                 http://localhost:8081 (admin / admin)"
echo "  OpenTelemetry Demo Store:   http://localhost:8080"
echo "  Prometheus API:             http://localhost:9090"
echo "  Alertmanager UI:            http://localhost:9093"
echo "  Grafana MCP Server (SSE):   http://localhost:8000/sse (--disable-write)"
