#!/usr/bin/env bash
# stop-stack.sh — stops the local agent + observability stack, in layers.
# Mirrors deploy-stack.sh: same namespaces, same release names, reverse order.
#
# Usage:
#   ./stop-stack.sh            stop agent processes + kubectl port-forwarding
#                              (safe, reversible — cluster and data untouched)
#   ./stop-stack.sh --full     also helm-uninstall every release deployed by
#                              deploy-stack.sh, then delete the now-empty
#                              observability/otel-demo namespaces (destructive
#                              — asks for confirmation)
#   ./stop-stack.sh --full -y  same as above, without the confirmation prompt
#
# Does NOT stop the Kubernetes cluster itself (Docker Desktop keeps its VM
# running regardless). To reclaim that, disable Kubernetes manually in
# Docker Desktop > Settings > Kubernetes.
#
# Note: `helm uninstall` intentionally does not remove CRDs it installed
# (e.g. kube-prometheus-stack's ServiceMonitor/PrometheusRule/Alertmanager
# CRDs) — that's a deliberate Helm safety behaviour, not a bug in this
# script. They're harmless to leave in place for the next deploy-stack.sh run.

set -euo pipefail

FULL=false
ASSUME_YES=false

for arg in "$@"; do
    case "$arg" in
        --full)
            FULL=true
            ;;
        -y | --yes)
            ASSUME_YES=true
            ;;
        -h | --help)
            sed -n '/^#!/,/^set -euo pipefail/p' "$0" | sed '1d;$d;s/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
done

log() {
    echo "==> $*"
}

stop_matching() {
    # $1 = human-readable name, $2 = pattern for pkill -f
    local name="$1"
    local pattern="$2"
    if pkill -f "$pattern" 2>/dev/null; then
        log "Stopped: $name"
    else
        log "Not running: $name"
    fi
}

# --- Layer 1: agent processes -----------------------------------------------

log "Stopping agent processes..."
stop_matching "main.py (polling agent)" "python main.py"
stop_matching "webhook_server.py (FastAPI webhook receiver)" "uvicorn webhook_server"

# --- Layer 2: kubectl port-forwarding ---------------------------------------

log "Stopping kubectl port-forward processes..."
stop_matching "kubectl port-forward" "kubectl port-forward"

if ! $FULL; then
    log "Done. Helm releases and the cluster are untouched."
    log "Re-run with --full to also tear down everything deploy-stack.sh installed."
    exit 0
fi

# --- Layer 3: Helm releases + namespaces (destructive) ----------------------

if ! command -v kubectl >/dev/null 2>&1 || ! command -v helm >/dev/null 2>&1; then
    echo "kubectl and/or helm not found on PATH — cannot tear down the cluster. Aborting." >&2
    exit 1
fi

# Same releases/namespaces as deploy-stack.sh, reverse order of install.
RELEASES=(
    "otel-demo:otel-demo"
    "grafana-mcp:observability"
    "prom-stack:observability"
    "promtail:observability"
    "loki:observability"
    "tempo:observability"
)
NAMESPACES=(otel-demo observability)

log "About to helm-uninstall these releases, then delete their namespaces:"
for entry in "${RELEASES[@]}"; do
    release="${entry%%:*}"
    namespace="${entry##*:}"
    echo "    - $release (namespace: $namespace)"
done
log "In-cluster data (Loki/Prometheus/Tempo use ephemeral local storage in"
log "this setup) is lost, same as it would be on a fresh 'helm uninstall'."

if ! $ASSUME_YES; then
    read -r -p "Type 'yes' to continue: " confirm
    if [[ "$confirm" != "yes" ]]; then
        log "Aborted — nothing was uninstalled."
        exit 0
    fi
fi

for entry in "${RELEASES[@]}"; do
    release="${entry%%:*}"
    namespace="${entry##*:}"
    if helm status "$release" -n "$namespace" >/dev/null 2>&1; then
        log "Uninstalling: $release (namespace: $namespace)"
        helm uninstall "$release" -n "$namespace"
    else
        log "Not installed, skipping: $release (namespace: $namespace)"
    fi
done

log "Deleting namespaces (catches anything helm uninstall didn't own directly)..."
for ns in "${NAMESPACES[@]}"; do
    if kubectl get namespace "$ns" >/dev/null 2>&1; then
        log "Deleting namespace: $ns"
        kubectl delete namespace "$ns" --wait=false
    else
        log "Namespace does not exist, skipping: $ns"
    fi
done

log "Namespace deletion requested in the background (--wait=false)."
log "Check progress with: kubectl get namespaces"
log "The Kubernetes cluster itself is still running — disable it manually in"
log "Docker Desktop > Settings > Kubernetes if you also want to reclaim its VM."