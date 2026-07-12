# Example Infrastructure: Observability Stack & OpenTelemetry Demo

This directory contains an automated, **"Everything-as-Code"** local Kubernetes deployment stack designed to validate AI-based diagnostic agents for cloud-native infrastructures.

It deploys a complete e-commerce microservices application (**OpenTelemetry Demo**) alongside a full **Observability Stack** (Prometheus, Grafana, Loki, Promtail, Tempo) and an official **Grafana Model Context Protocol (MCP) Server** running in read-only mode for AI diagnostic assistants.

---

## 🚀 Quick Start (1-Command Deployment)

Deployment is managed via automated scripts that configure Helm repositories, install/upgrade all components using declarative values files in `values/`, and start persistent background port forwarding.

### Prerequisites
- A running Kubernetes cluster (e.g., **Docker Desktop Kubernetes**, **kind**, or **minikube**).
- **kubectl** and **Helm 3** installed and available in your PATH.

### On Windows (PowerShell)
Run the automated PowerShell deployment script from the project root or inside `example-infrastructure`:

```powershell
.\example-infrastructure\scripts\windows\deploy-stack.ps1
```

### On Linux / macOS / Bash
Run the bash deployment script:

```bash
./example-infrastructure/scripts/bash/deploy-stack.sh
```

> **Note:** Both scripts automatically start persistent port forwarding at the end of deployment. If your cluster reboots or you close the port forwarding windows, you can restart port forwarding at any time without redeploying:
> - **Windows:** `.\example-infrastructure\scripts\windows\start-port-forwards.ps1`
> - **Bash:** `./example-infrastructure/scripts/bash/start-port-forwards.sh`

---

## 🌐 Available Endpoints & Services

Once deployed and port forwarding is active, the following services are available locally:

| Service | Local URL | Credentials / Notes |
| :--- | :--- | :--- |
| **Grafana UI** | http://localhost:8081 | Username: `admin`<br/>Password: `admin` |
| **OpenTelemetry Demo Store** | http://localhost:8080 | Live e-commerce store with automated simulated traffic |
| **Grafana MCP Server (SSE)** | http://localhost:8000/sse | Model Context Protocol Server for AI Agents (`--disable-write`) |
| **Prometheus API & UI** | http://localhost:9090 | Direct Prometheus expression browser |
| **Alertmanager UI** | http://localhost:9093 | Active alert groups and routing |

---

## 🤖 AI Agent Integration via Grafana MCP Server

The stack includes an official **Grafana MCP Server** (`grafana-community/grafana-mcp`) configured explicitly for safe AI diagnosis:

### Read-Only Safety Guarantee (`--disable-write: true`)
The MCP server is configured with `disableWrite: true` in [`values/grafana-mcp-values.yaml`](file:///c:/Users/wojpa/Documents/inzynierka/Agent-Based-System-for-Supporting-Incident-Diagnosis-in-Cloud-Native-Infrastructures/example-infrastructure/values/grafana-mcp-values.yaml). AI diagnostic agents can:
- ✅ Discover and inspect dashboards, panels, and variables (`search_dashboards`, `get_dashboard`).
- ✅ Execute PromQL queries against Prometheus (`query_prometheus`).
- ✅ Execute LogQL queries against Loki logs (`query_loki_logs`, `query_loki_stats`).
- ✅ Inspect active alerts and OnCall rules (`get_alert_rules`).
- ❌ **Cannot** modify, delete, or create dashboards, alerts, or datasources.

### Connecting Your AI Client
Configure your MCP client (Cursor, Claude Desktop, custom Python RAG/agent) to connect via Server-Sent Events (SSE):

```json
{
  "mcpServers": {
    "grafana-observability": {
      "transport": "sse",
      "url": "http://localhost:8000/sse"
    }
  }
}
```

---

## 📁 Repository Directory Structure

```text
example-infrastructure/
├── README.md                          # This documentation
├── scripts/
│   ├── windows/
│   │   ├── deploy-stack.ps1           # Full automated deployment & upgrade script
│   │   └── start-port-forwards.ps1    # Persistent port forwarding for Windows
│   └── bash/
│       ├── deploy-stack.sh            # Full automated deployment script for Bash
│       └── start-port-forwards.sh     # Background port forwarding for Linux/macOS
└── values/                            # Declarative Helm Values Configuration
    ├── grafana-mcp-values.yaml        # Grafana MCP Server read-only config
    ├── prom-values.yaml               # Kube-Prometheus-Stack & Grafana settings
    ├── loki-values.yaml               # Loki log store settings
    ├── promtail-values.yaml           # Promtail log daemonset collector
    ├── tempo-values.yaml              # Tempo distributed tracing engine
    └── otel-demo-values.yaml          # OpenTelemetry Demo resource limits & config
```

---

## ⚙️ Key Configuration Details

- **Docker Desktop Compatibility:** In `values/prom-values.yaml`, `prometheus-node-exporter` is disabled (`nodeExporter.enabled: false`) to prevent host rootfs mount permission errors on Windows/WSL2 Docker Desktop VMs.
- **Resource Limits:** Optimized in `otel-demo-values.yaml` and `grafana-mcp-values.yaml` to ensure smooth operation on local developer workstations (16GB+ RAM recommended).
