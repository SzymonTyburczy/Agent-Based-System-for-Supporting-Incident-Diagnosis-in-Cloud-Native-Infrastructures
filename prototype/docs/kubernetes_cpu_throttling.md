# Kubernetes CPU Resource Management and Throttling

## Overview
Kubernetes enforces CPU limits using the Linux Completely Fair Scheduler (CFS). When a container exceeds its CPU limit, CFS throttling is applied, which causes the container's processes to be paused periodically. This results in increased latency, timeouts, and reduced throughput even when physical CPU capacity is available on the node.

## CPU Requests vs Limits
- **CPU Request**: The amount of CPU guaranteed to the container. Used by the scheduler to place pods.
- **CPU Limit**: The maximum CPU the container can use. Enforced by CFS bandwidth control.

A high throttle rate (>25%) indicates the container frequently hits its CPU limit.

## Symptoms of CPU Throttling
- Increased p99 and p999 latency
- Request timeouts proportional to throttle rate
- `container_cpu_cfs_throttled_seconds_total` metric increasing
- Application logs showing slow processing or queue buildup
- `kubectl top pods` showing CPU at or near limit

## Diagnosis Commands
```bash
# Check CPU throttling rate
kubectl top pods -n <namespace>

# Check CPU limits configuration
kubectl describe pod <pod-name> -n <namespace> | grep -A5 "Limits"

# Check throttling metric in Prometheus
rate(container_cpu_cfs_throttled_seconds_total[5m]) / rate(container_cpu_cfs_periods_total[5m])
```

## Remediation
1. **Increase CPU limits**: Edit the deployment to raise the CPU limit. A ratio of request:limit of 1:2 is recommended for variable workloads.
   ```yaml
   resources:
     requests:
       cpu: "500m"
     limits:
       cpu: "2000m"
   ```

2. **Enable Horizontal Pod Autoscaler (HPA)**: Scale out instead of up.
   ```bash
   kubectl autoscale deployment <name> --cpu-percent=70 --min=3 --max=10 -n <namespace>
   ```

3. **Optimize application code**: Profile the application to find CPU hotspots. Use tools like `pprof` (Go), `py-spy` (Python), or `async-profiler` (JVM).

4. **Use VPA (Vertical Pod Autoscaler)**: Automatically adjusts CPU requests/limits based on historical usage.

5. **Node affinity and resource pools**: Place CPU-intensive workloads on dedicated node pools with higher CPU capacity.

## Prevention
- Set resource requests based on actual p95 usage, measured over at least 7 days.
- Configure PodDisruptionBudgets to ensure enough replicas are always running.
- Use metrics-server and Prometheus to continuously monitor `container_cpu_cfs_throttled_seconds_total`.
- Alert on throttle rate > 10% sustained over 5 minutes.
