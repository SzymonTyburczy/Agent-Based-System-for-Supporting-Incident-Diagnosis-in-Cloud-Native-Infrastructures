# Runbook: AdServiceHighCpu — High CPU Utilization on Ad Service

| Metadata | Details |
| :--- | :--- |
| **Alert Name** | `AdServiceHighCpu` |
| **Severity** | `Critical` (P1) |
| **Target Service** | `ad` / `adService` (Java / Netty gRPC microservice) |
| **Namespace** | `otel-demo` |
| **PromQL Rule** | `rate(container_cpu_usage_seconds_total{namespace="otel-demo", pod=~"ad-.*"}[1m]) > 1` |
| **Threshold** | CPU usage exceeds 1.0 vCPU for more than 1 minute (`for: 1m`) |
| **Last Updated** | 2026-10-17 |

---

## 1. Overview & Problem Description

The `AdServiceHighCpu` alert fires when the JVM process inside the `ad` pod consumes more than 100% of a full CPU core continuously for at least 60 seconds. 

Under normal operating conditions, the Ad Service serves contextual banner and product advertisements via gRPC (`GetAds` RPC) with low CPU utilization (~0.05–0.15 vCPU). When CPU usage spikes above 1.0 vCPU, the Netty event loop threads become starved of CPU cycles, resulting in severe response latency spikes, request queue buildup, and cascading connection timeouts for upstream consumers (primarily the `frontend` web application).

### Business & User Impact
* Product and category pages load slowly or fail to render banner advertisements.
* Upstream frontend proxies experience gRPC context deadlines exceeded (`DeadlineExceeded`).
* Overall customer browsing experience degrades significantly.

---

## 2. Immediate Triage & Diagnostics

When paged by this alert, follow these diagnostic steps:

### Step 1: Verify Current CPU Consumption in Prometheus
Run the following PromQL query to assess the severity and trend:
```promql
rate(container_cpu_usage_seconds_total{namespace="otel-demo", pod=~"ad-.*"}[1m])
```
Check if CPU throttling is occurring at the container level:
```promql
rate(container_cpu_cfs_throttled_seconds_total{namespace="otel-demo", pod=~"ad-.*"}[1m])
```

### Step 2: Inspect Pod Health and Resource Allocation
Check the status, restarts, and live CPU/memory metrics using `kubectl`:
```bash
kubectl get pods -n otel-demo -l app.kubernetes.io/component=ad
kubectl top pod -n otel-demo -l app.kubernetes.io/component=ad
kubectl describe pod -n otel-demo -l app.kubernetes.io/component=ad
```

### Step 3: Inspect Service Logs for Execution Loops and GC Storms
Check the container logs via Loki or `kubectl logs`:
```bash
kubectl logs -n otel-demo -l app.kubernetes.io/component=ad --tail=100
```
Look for:
* Tight execution loops or repetitive calculation warnings.
* Frequent Full GC events or memory pressure messages (e.g., `GC overhead limit exceeded`).
* Thread pool exhaustion or saturated gRPC worker queues.

---

## 3. Potential Root Causes

1. **Experimental Feature Flag Toggled (`adHighCpu`):**
   * In our codebase, the application incorporates a diagnostic / experimental feature flag named **`adHighCpu`** (managed via Flagd / application feature flags).
   * If an engineer, operator, or automated deployment toggled `adHighCpu` to `on` (or if an experiment was improperly left running in configuration), the service activates a high-intensity CPU computation loop in the ad rendering path.
   * *Check:* Verify the active feature flags in the Flagd configuration (`kubectl get configmap flagd-config -n otel-demo -o yaml`) or in the feature flags UI at `http://localhost:8080/feature-flags`. Look for `"adHighCpu": "on"`.
2. **Algorithmic Lock / Inefficient Category Matching:**
   * A surge of complex category ad requests can cause the matching algorithm to perform exponential lookups if the ad inventory cache is corrupted or invalidated.
3. **JVM Thread Contention or Garbage Collection Thrashing:**
   * Severe memory fragmentation or misconfigured heap limits can cause parallel GC threads to monopolize the available CPU cores.

---

## 4. Remediation & Action Plan

### Action A: Deactivate Experimental Feature Flag (Fastest Fix)
If the high CPU condition is caused by the `adHighCpu` flag:
1. Open the Feature Flags management dashboard (`http://localhost:8080/feature-flags`) or edit `flagd-config`:
   ```bash
   kubectl edit configmap flagd-config -n otel-demo
   ```
2. Locate the `adHighCpu` flag definition and set its variant/default to `off`:
   ```json
   "adHighCpu": {
     "defaultVariant": "off",
     "state": "ENABLED"
   }
   ```
3. The Flagd daemon dynamically syncs changes to the running services within seconds without requiring a restart.

### Action B: Perform a Rolling Restart of the Service
If the JVM is stuck in an unrecoverable state, thread deadlock, or GC loop:
```bash
kubectl rollout restart deployment/ad -n otel-demo
kubectl rollout status deployment/ad -n otel-demo
```
This spawns a fresh container with clean heap and initialized thread pools.

### Action C: Scale Replicas (If Caused by Real Traffic Spikes)
If the high CPU is driven by genuine organic traffic bursts:
```bash
kubectl scale deployment/ad -n otel-demo --replicas=2
```

---

## 5. Verification & Recovery Confirmation

After executing the mitigation:
1. Verify that the CPU usage drops back below the 0.2 vCPU baseline:
   ```promql
   rate(container_cpu_usage_seconds_total{namespace="otel-demo", pod=~"ad-.*"}[1m]) < 0.5
   ```
2. Check Prometheus alert status: `AdServiceHighCpu` should transition from `firing` $\rightarrow$ `resolved` within 1–2 minutes.
3. Validate that frontend ad placement latency returns to normal levels.
