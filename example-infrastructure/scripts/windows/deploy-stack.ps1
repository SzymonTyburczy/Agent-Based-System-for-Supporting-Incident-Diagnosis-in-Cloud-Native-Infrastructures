<#
.SYNOPSIS
    Script to deploy/upgrade the full Observability stack and the OpenTelemetry Demo e-commerce application on Kubernetes.
#>

$ErrorActionPreference = "Stop"

# Find values directory relative to script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExampleInfraDir = (Get-Item $ScriptDir).Parent.Parent.FullName
$ValuesDir = Join-Path $ExampleInfraDir "values"

Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host " DEPLOYING OBSERVABILITY STACK AND OTEL-DEMO" -ForegroundColor Cyan
Write-Host "===================================================================" -ForegroundColor Cyan

# 1. Create Kubernetes namespaces
Write-Host "`n[1/5] Creating namespaces (observability, otel-demo)..." -ForegroundColor Yellow
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace otel-demo --dry-run=client -o yaml | kubectl apply -f -

# 2. Add and update Helm repositories
Write-Host "`n[2/5] Configuring Helm repositories..." -ForegroundColor Yellow
helm repo add grafana https://grafana.github.io/helm-charts --force-update
helm repo add grafana-community https://grafana-community.github.io/helm-charts --force-update
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts --force-update
helm repo update

# 3. Deploy Observability stack in 'observability' namespace
Write-Host "`n[3/5] Deploying Observability components (Tempo, Loki, Promtail, Kube-Prometheus-Stack)..." -ForegroundColor Yellow

Write-Host " -> Deploying Grafana Tempo..."
helm upgrade --install tempo grafana/tempo -n observability -f "$ValuesDir\tempo-values.yaml"

Write-Host " -> Deploying Grafana Loki..."
helm upgrade --install loki grafana/loki -n observability -f "$ValuesDir\loki-values.yaml"

Write-Host " -> Deploying Grafana Promtail..."
helm upgrade --install promtail grafana/promtail -n observability -f "$ValuesDir\promtail-values.yaml"

Write-Host " -> Deploying Prometheus & Grafana Stack..."
helm upgrade --install prom-stack prometheus-community/kube-prometheus-stack -n observability -f "$ValuesDir\prom-values.yaml"

Write-Host " -> Deploying Grafana MCP Server (read-only)..."
helm upgrade --install grafana-mcp grafana-community/grafana-mcp -n observability -f "$ValuesDir\grafana-mcp-values.yaml"

# 4. Deploy OpenTelemetry Demo application in 'otel-demo' namespace
Write-Host "`n[4/5] Deploying OpenTelemetry Demo e-commerce application..." -ForegroundColor Yellow
helm upgrade --install otel-demo open-telemetry/opentelemetry-demo -n otel-demo -f "$ValuesDir\otel-demo-values.yaml"

# 4.5 Deploy custom thesis alerts
Write-Host "`n[4.5/5] Deploying Custom Prometheus Alerts..." -ForegroundColor Yellow
kubectl apply -f "$ExampleInfraDir\alerts"

# 5. Start persistent background port forwarding
Write-Host "`n[5/5] Starting persistent port forwarding windows..." -ForegroundColor Yellow

& "$ScriptDir\start-port-forwards.ps1"

Write-Host "`n===================================================================" -ForegroundColor Green
Write-Host " DEPLOYMENT AND PORT FORWARDING COMPLETED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "===================================================================" -ForegroundColor Green
Write-Host "`nActive port forwarding running in the background:"
Write-Host "  1. Grafana (Observability UI):          http://localhost:8081  (admin / admin)" -ForegroundColor Cyan
Write-Host "  2. OpenTelemetry Demo Store & UI:       http://localhost:8080" -ForegroundColor Cyan
Write-Host "  3. Prometheus API:                      http://localhost:9090" -ForegroundColor Cyan
Write-Host "  4. Alertmanager UI:                     http://localhost:9093" -ForegroundColor Cyan
Write-Host ""
