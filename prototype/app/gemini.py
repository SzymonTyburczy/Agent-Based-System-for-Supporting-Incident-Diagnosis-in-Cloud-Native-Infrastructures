import os
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

_client_initialized = False


def _ensure_client():
    global _client_initialized
    if not _client_initialized:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is not set. Copy .env.example to .env and add your key.")
        genai.configure(api_key=api_key)
        _client_initialized = True


def build_diagnosis_prompt(scenario: dict) -> str:
    """Build a detailed prompt for Gemini from the collected telemetry and RAG data."""
    metrics_str = "\n".join(f"  - {k}: {v}" for k, v in scenario["metrics"].items())
    logs_str = "\n".join(f"  {log}" for log in scenario["logs"])
    rag_str = "\n\n".join(
        f"  [Source: {doc['source']}]\n  {doc['content']}"
        for doc in scenario["rag_docs"]
    )

    return f"""You are an expert Site Reliability Engineer (SRE) and cloud-native infrastructure specialist.
You are analyzing an incident in a Kubernetes-based production environment.

## Incident Alert
- **Alert Type**: {scenario['alert_type']}
- **Severity**: {scenario['severity'].upper()}
- **Namespace**: {scenario['namespace']}
- **Affected Service**: {scenario['service']}
- **Description**: {scenario['description']}

## Collected Metrics
{metrics_str}

## Recent Log Entries
{logs_str}

## Retrieved Documentation (RAG)
{rag_str}

---

Based on the above telemetry data and documentation, provide a structured diagnostic report. Your report MUST follow this exact Markdown structure:

## 🔍 Root Cause Analysis
[Explain the primary root cause of the incident in 2-3 sentences. Be specific, referencing actual metric values and log entries.]

## 📊 Impact Assessment
[Describe the business and technical impact. What services are affected? What is the user-facing impact?]

## 🛠️ Recommended Remediation Actions
Provide a numbered, prioritized list of concrete remediation steps. For each step:
1. **[Action Name]**: Specific command or configuration change with exact values based on the collected data.

## ⚡ Immediate Actions (< 5 minutes)
[List 2-3 things the on-call engineer should do RIGHT NOW to mitigate the incident.]

## 🔮 Long-term Prevention
[List 2-3 architectural or process improvements to prevent recurrence.]

## ⚠️ Risk Assessment
[What could go wrong during remediation? Any dependencies to be aware of?]

Keep the report concise, actionable, and focused on the specific data provided. Use the exact metric values and log timestamps in your analysis."""


async def generate_diagnosis_stream(scenario: dict):
    """Generate a streaming diagnosis report from Gemini."""
    _ensure_client()
    model = genai.GenerativeModel("gemini-2.0-flash")
    prompt = build_diagnosis_prompt(scenario)

    response = model.generate_content(prompt, stream=True)
    for chunk in response:
        if chunk.text:
            yield chunk.text
