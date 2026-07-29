"""Example tools backed by a local CLI (kubectl).

Security note: the agent can execute commands against the infrastructure, so
every CLI-backed tool must:
  1. invoke one fixed, predetermined command (never a free-form shell/eval),
  2. restrict the allowed argument range (here: a namespace allowlist),
  3. enforce a hard timeout, so a hung command cannot block the agent.

Token-budget note: raw `kubectl describe pod` output can run to several
hundred lines (env vars, volumes, tolerations, full event history, ...).
Every tool result is appended to the conversation history and resent in
full on every subsequent LLM call, so a couple of large outputs can burn
through a tokens-per-minute (TPM) budget on their own, independent of how
many tool schemas are registered. Rather than truncating that text blindly,
`KubectlPodDiagnosticsTool` below queries the same data in JSON form
(`kubectl get ... -o json`) and extracts only the fields relevant to
diagnosing a problem: pod phase, per-container restart/waiting/terminated
state, unhealthy conditions, and recent Warning-type events. Everything
else (env vars, volume mounts, tolerations, full event history) is dropped
before the result ever reaches the LLM.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from agent_core.tools.base import Tool, ToolResult

DEFAULT_TIMEOUT_SECONDS = 15

# Fallback safety net for tools that return plain text rather than JSON
# (e.g. `kubectl get pods -o wide`), which is not filtered field-by-field.
MAX_OUTPUT_CHARS = 4000


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return f"{text[:limit]}\n... [output truncated, {omitted} more characters omitted]"


async def _run_kubectl(
    *args: str,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    truncate_output: bool = True,
) -> ToolResult:
    """Runs kubectl and returns its stdout as text.

    `truncate_output=False` is used when the caller is about to parse the
    output as JSON — truncating first could cut a JSON document mid-token
    and make it unparseable.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "kubectl",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return ToolResult(success=False, error="'kubectl' executable not found in PATH.")

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return ToolResult(success=False, error=f"kubectl exceeded the {timeout}s timeout")

    if proc.returncode != 0:
        return ToolResult(success=False, error=stderr.decode(errors="replace").strip())

    text = stdout.decode(errors="replace")
    if truncate_output:
        text = _truncate(text)
    return ToolResult(success=True, data=text)


async def _run_kubectl_json(*args: str, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> ToolResult:
    """Runs kubectl and parses its stdout as JSON (expects an `-o json` call)."""
    result = await _run_kubectl(*args, timeout=timeout, truncate_output=False)
    if not result.success:
        return result
    try:
        return ToolResult(success=True, data=json.loads(result.data))
    except json.JSONDecodeError as exc:
        return ToolResult(success=False, error=f"Failed to parse kubectl JSON output: {exc}")


def _summarize_container_status(status: dict[str, Any]) -> dict[str, Any]:
    """Extracts only the fields useful for diagnosis from one containerStatuses entry."""
    entry: dict[str, Any] = {
        "name": status.get("name"),
        "ready": status.get("ready"),
        "restart_count": status.get("restartCount"),
    }

    state = status.get("state", {})
    if "waiting" in state:
        entry["state"] = "waiting"
        entry["reason"] = state["waiting"].get("reason")
        entry["message"] = state["waiting"].get("message")
    elif "terminated" in state:
        entry["state"] = "terminated"
        entry["reason"] = state["terminated"].get("reason")
        entry["exit_code"] = state["terminated"].get("exitCode")
        entry["message"] = state["terminated"].get("message")
    else:
        entry["state"] = "running"

    last_terminated = status.get("lastState", {}).get("terminated")
    if last_terminated:
        entry["previous_termination_reason"] = last_terminated.get("reason")
        entry["previous_exit_code"] = last_terminated.get("exitCode")

    return entry


def summarize_pod(pod: dict[str, Any]) -> dict[str, Any]:
    """Reduces a full `kubectl get pod -o json` document to diagnosis-relevant fields."""
    metadata = pod.get("metadata", {})
    status = pod.get("status", {})

    containers = [
        _summarize_container_status(cs) for cs in status.get("containerStatuses", [])
    ]
    # Conditions where status != "True" are the ones worth surfacing
    # (e.g. Ready=False, PodScheduled=False, ...); a healthy pod has none.
    unhealthy_conditions = [
        {"type": c.get("type"), "status": c.get("status"), "reason": c.get("reason")}
        for c in status.get("conditions", [])
        if c.get("status") != "True"
    ]

    return {
        "pod": metadata.get("name"),
        "namespace": metadata.get("namespace"),
        "phase": status.get("phase"),
        "start_time": status.get("startTime"),
        "containers": containers,
        "unhealthy_conditions": unhealthy_conditions,
    }


def summarize_events(events: list[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
    """Keeps only Warning-type events (the ones that explain failures), most recent first."""
    warnings = [e for e in events if e.get("type") == "Warning"]
    warnings.sort(key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "", reverse=True)
    return [
        {
            "reason": e.get("reason"),
            "message": e.get("message"),
            "count": e.get("count"),
            "last_timestamp": e.get("lastTimestamp"),
        }
        for e in warnings[:limit]
    ]


class KubectlGetPodsTool(Tool):
    name = "kubectl_get_pods"
    description = (
        "Lists pods in the given namespace (kubectl get pods -o wide), read-only."
    )
    parameters_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "namespace": {
                "type": "string",
                "description": "Kubernetes namespace, e.g. 'otel-demo'",
            }
        },
        "required": ["namespace"],
    }

    def __init__(self, allowed_namespaces: set[str] | None = None) -> None:
        # None = no restriction (e.g. in a local dev environment),
        # but in practice this should always be set.
        self.allowed_namespaces = allowed_namespaces

    async def execute(self, namespace: str) -> ToolResult:
        if self.allowed_namespaces is not None and namespace not in self.allowed_namespaces:
            return ToolResult(
                success=False,
                error=(
                    f"Namespace '{namespace}' is not on the allowlist "
                    f"({sorted(self.allowed_namespaces)})."
                ),
            )
        return await _run_kubectl("get", "pods", "-n", namespace, "-o", "wide")


class KubectlPodDiagnosticsTool(Tool):
    name = "kubectl_pod_diagnostics"
    description = (
        "Returns a short diagnostic summary for one pod: phase, per-container "
        "restart/crash state, unhealthy conditions, and recent warning events. "
        "Filters out everything not relevant to diagnosis (env vars, volumes, "
        "tolerations, full event history). Read-only."
    )
    parameters_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "namespace": {"type": "string"},
            "pod_name": {"type": "string"},
        },
        "required": ["namespace", "pod_name"],
    }

    def __init__(self, allowed_namespaces: set[str] | None = None) -> None:
        self.allowed_namespaces = allowed_namespaces

    async def execute(self, namespace: str, pod_name: str) -> ToolResult:
        if self.allowed_namespaces is not None and namespace not in self.allowed_namespaces:
            return ToolResult(
                success=False,
                error=(
                    f"Namespace '{namespace}' is not on the allowlist "
                    f"({sorted(self.allowed_namespaces)})."
                ),
            )

        pod_result = await _run_kubectl_json("get", "pod", pod_name, "-n", namespace, "-o", "json")
        if not pod_result.success:
            return pod_result

        summary = summarize_pod(pod_result.data)

        events_result = await _run_kubectl_json(
            "get",
            "events",
            "-n",
            namespace,
            "--field-selector",
            f"involvedObject.name={pod_name}",
            "-o",
            "json",
        )
        if events_result.success:
            summary["recent_warning_events"] = summarize_events(
                events_result.data.get("items", [])
            )
        else:
            # Events are supplementary — a pod summary without them is still useful,
            # so a failure here does not fail the whole tool call.
            summary["recent_warning_events_error"] = events_result.error

        return ToolResult(success=True, data=summary)
