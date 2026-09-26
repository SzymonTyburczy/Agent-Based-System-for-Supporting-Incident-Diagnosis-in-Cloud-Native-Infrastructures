# Runbook: CrashLoopBackOff

The application pod restarts in a loop. This runbook walks through the diagnosis
and the most common causes.

## Diagnosis

Check the state of the pods in the demo namespace:

```bash
kubectl get pods -n otel-demo
kubectl describe pod <pod-name> -n otel-demo
```

Typical causes are a wrong configuration, missing resources or a failing startup
probe.

### Container logs

Fetch the logs of the previous container instance and compare the memory limits
with the actual usage:

```yaml
# sample limits configuration — a # in YAML is not a Markdown heading
resources:
  limits:
    memory: "512Mi"

  requests:
    memory: "256Mi"
# end of sample
```

Exit code 137 means OOMKilled.

## Exit codes

| Code | Meaning                  |
| ---- | ------------------------ |
| 137  | OOMKilled (memory limit) |
| 1    | application error        |

## Known workarounds

Raise the memory limits or fix the startup configuration. After the change,
watch the restarts for at least five minutes.
