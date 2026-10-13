---
requires_any: kubectl_get_pods, kubectl_pod_diagnostics
---
Kubernetes:
- kubectl works only in: {{namespaces}}. Use metrics and logs for other namespaces.
- OOMKilled (exit 137) means the memory limit was hit, not CPU.
