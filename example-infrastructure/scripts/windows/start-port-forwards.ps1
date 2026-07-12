<#
.SYNOPSIS
    Start all required port forwarding jobs in persistent minimized command prompt windows.
#>

Write-Host "Stopping any existing kubectl port-forward processes..." -ForegroundColor Yellow
Get-Process kubectl -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "Starting persistent port forwarding windows..." -ForegroundColor Yellow

Start-Process -FilePath "cmd.exe" -ArgumentList "/k title OTel-Demo-Store (8080) && kubectl port-forward svc/frontend-proxy 8080:8080 -n otel-demo" -WindowStyle Minimized
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title Grafana-UI (8081) && kubectl port-forward svc/prom-stack-grafana 8081:80 -n observability" -WindowStyle Minimized
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title Prometheus-API (9090) && kubectl port-forward svc/prom-stack-kube-prometheus-prometheus 9090:9090 -n observability" -WindowStyle Minimized
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title Alertmanager-UI (9093) && kubectl port-forward svc/prom-stack-kube-prometheus-alertmanager 9093:9093 -n observability" -WindowStyle Minimized
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title Grafana-MCP-Server (8000) && kubectl port-forward svc/grafana-mcp 8000:8000 -n observability" -WindowStyle Minimized

Write-Host "`nActive Port Forwards running in minimized windows:" -ForegroundColor Green
Write-Host "  1. Grafana UI:                 http://localhost:8081 (admin / admin)" -ForegroundColor Cyan
Write-Host "  2. OpenTelemetry Demo Store:   http://localhost:8080" -ForegroundColor Cyan
Write-Host "  3. Prometheus API:             http://localhost:9090" -ForegroundColor Cyan
Write-Host "  4. Alertmanager UI:            http://localhost:9093" -ForegroundColor Cyan
Write-Host "  5. Grafana MCP Server (SSE):   http://localhost:8000/sse (--disable-write)" -ForegroundColor Cyan
