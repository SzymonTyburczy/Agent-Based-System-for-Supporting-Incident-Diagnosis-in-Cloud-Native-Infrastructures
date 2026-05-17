# Kubernetes Horizontal Pod Autoscaler (HPA) Configuration Guide

## Overview
The Horizontal Pod Autoscaler (HPA) automatically scales the number of pod replicas in a Deployment, ReplicaSet, or StatefulSet based on observed metrics such as CPU utilization, memory usage, or custom metrics.

## Prerequisites
- `metrics-server` must be deployed in the cluster.
- Resource requests must be set on containers (HPA uses requests as the baseline for percentage calculations).

## Basic HPA Configuration

### CPU-based autoscaling
```bash
kubectl autoscale deployment api-gateway \
  --cpu-percent=70 \
  --min=3 \
  --max=20 \
  -n production
```

### YAML manifest
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300
```

## HPA Tuning for High-Traffic Services
- Set `stabilizationWindowSeconds` for scaleDown to 300s to prevent flapping.
- For latency-sensitive services, use custom metrics (e.g., `requests_per_second` from Prometheus via the `custom.metrics.k8s.io` API).
- Combine HPA with PodDisruptionBudget to ensure availability during scale-down.

## Troubleshooting HPA
```bash
# Check HPA status
kubectl describe hpa api-gateway-hpa -n production

# Check if metrics-server is running
kubectl get deployment metrics-server -n kube-system

# Check current metrics
kubectl top pods -n production
```

## Common Issues
- **"unknown" metrics**: metrics-server not running or resource requests not set.
- **HPA not scaling up fast enough**: Reduce `stabilizationWindowSeconds` for scaleUp.
- **Thrashing**: Increase `stabilizationWindowSeconds` for scaleDown.
