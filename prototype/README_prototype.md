# IncidentIQ — Prototype Setup Guide

This directory contains the working prototype for the **Agent-Based System for Supporting Incident Diagnosis in Cloud-Native Infrastructures**.

## Prerequisites

- Python 3.11+
- A [Google Gemini API Key](https://aistudio.google.com/app/apikey) (free tier works)

## Setup

### 1. Create and activate a virtual environment

```bash
cd prototype
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure your Gemini API key

```bash
# Copy the example env file
copy .env.example .env     # Windows
cp .env.example .env       # macOS/Linux

# Edit .env and paste your key:
# GEMINI_API_KEY=AIza...
```

### 4. Start the server

```bash
uvicorn app.main:app --reload
```

### 5. Open the dashboard

Navigate to: **http://localhost:8000**

---

## How It Works

The system simulates a multi-agent diagnostic pipeline:

| Step | Description |
|------|-------------|
| `ALERT_RECEIVED` | Parses the incoming Alertmanager-style alert |
| `ANALYZING_METRICS` | Fetches simulated metrics (CPU, memory, connections, etc.) |
| `QUERYING_LOGS` | Retrieves recent log entries from a simulated Elasticsearch |
| `RAG_SEARCH` | Finds relevant documentation snippets (Retrieval-Augmented Generation) |
| `GENERATING_REPORT` | Calls Gemini AI to produce the final diagnostic report (streamed live) |

## Available Scenarios

| ID | Name | Alert Type | Severity |
|----|------|-----------|---------|
| `high_cpu` | High CPU Usage | `CPUThrottlingHigh` | Critical |
| `db_timeout` | Database Connection Timeout | `DatabaseConnectionFailed` | Critical |
| `oomkill` | Memory Leak (OOMKill) | `KubePodOOMKilled` | Warning |
| `cascade_failure` | Service Cascade Failure | `ServiceUnavailable` | Critical |
| `disk_pressure` | Disk Space Critical | `NodeDiskPressure` | Warning |

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scenarios` | GET | List all available incident scenarios |
| `/api/diagnose` | POST | Start diagnosis pipeline (returns SSE stream) |

### Example request

```bash
curl -X POST http://localhost:8000/api/diagnose \
  -H "Content-Type: application/json" \
  -d '{"scenario_id": "high_cpu"}'
```

---

## Authors

Engineering thesis project by:
- Szymon Tyburczy
- Seweryn Tasior
- Filip Mokrzycki
- Wojciech Pawlina
