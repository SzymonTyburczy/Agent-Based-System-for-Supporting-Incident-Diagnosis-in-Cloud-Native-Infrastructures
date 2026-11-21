# Runbook: ImageSlowLoad — High Latency on Product Image Ingress

| Metadata | Details |
| :--- | :--- |
| **Alert Name** | `ImageSlowLoad` |
| **Severity** | `Warning` (P2) |
| **Target Service** | `frontend-proxy` (Envoy) / `image-provider` (Go) |
| **Namespace** | `otel-demo` |
| **PromQL Rule** | `histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="frontend-proxy", span_name="ingress"}[2m])) by (le)) > 3000` |
| **Threshold** | 95th percentile ingress latency exceeds 3000ms (3.0s) for more than 1 minute (`for: 1m`) |
| **Last Updated** | 2026-11-21 |

---

## 1. Overview & Problem Description

The `ImageSlowLoad` alert triggers when the 95th percentile (p95) response latency measured at the `frontend-proxy` Envoy ingress exceeds 3 seconds over a 2-minute sliding window.

Under typical operating conditions, product catalog images and static assets are served in under 100ms. When p95 latency spikes beyond 3000ms, the frontend web application experiences noticeable asset rendering stalls, leading to broken layout shifts, missing product previews, and degraded browser rendering speeds.

### Business & User Impact
* Product thumbnails and banner assets load slowly, showing blank frames or loading spinners.
* Customer perceived page load time increases significantly.
* Reduced engagement and catalog browsing performance on e-commerce pages.

---

## 2. Immediate Triage & Diagnostics

When paged by this alert, follow these diagnostic steps:

### Step 1: Inspect Ingress Latency Distribution in Prometheus
Run the following query to observe current p95, p90, and p50 latencies across ingress spans:
```promql
histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="frontend-proxy", span_name="ingress"}[2m])) by (le))
```
Check downstream `image-provider` latency to isolate whether delay occurs inside the backend or at proxy layer:
```promql
histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="image-provider"}[2m])) by (le))
```

### Step 2: Inspect Proxy and Image Provider Pod Health
```bash
kubectl get pods -n otel-demo -l app.kubernetes.io/component=frontend-proxy
kubectl get pods -n otel-demo -l app.kubernetes.io/component=image-provider
kubectl top pod -n otel-demo -l app.kubernetes.io/component=frontend-proxy
kubectl top pod -n otel-demo -l app.kubernetes.io/component=image-provider
```

### Step 3: Check Distributed Traces and Proxy Logs
Inspect Envoy ingress logs and distributed traces in Jaeger/Tempo:
```bash
kubectl logs -n otel-demo -l app.kubernetes.io/component=frontend-proxy --tail=100
```
Look for:
* `x-envoy-fault-delay-request` response headers or fault delay injection logs.
* Network socket saturation or connection backlog warnings.
* Upstream connection timeouts or keepalive resets to `image-provider`.

---

## 3. Potential Root Causes

1. **Static Storage / CDN Edge Bottlenecks or Bandwidth Saturation:**
   * High concurrent downloads of high-resolution product media saturating pod network interface bandwidth.
2. **Upstream Asset Server Latency (`image-provider`):**
   * High disk I/O wait times or CPU throttling on the Go-based `image-provider` microservice serving catalog images.
3. **Network Routing & Proxy Delay Configuration:**
   * Proxy-level rate limiting, keep-alive pool exhaustion, or faulty route filters delaying static asset responses.
   * *Note on testing environments:* In staging or test clusters, check whether diagnostic latency injection flags (such as `imageSlowLoad` in Flagd) were configured to simulate poor mobile bandwidth conditions.

---

## 4. Remediation & Action Plan

### Action A: Check Configuration and Fault Injections
Check if simulated edge latency rules or feature flags are active in the cluster:
1. Verify Flagd configuration:
   ```bash
   kubectl get configmap flagd-config -n otel-demo -o yaml
   ```
2. If `imageSlowLoad` is set to `5sec` or `10sec`, reset it to `off` via the dashboard (`http://localhost:8080/feature-flags`) or by patching the ConfigMap:
   ```json
   "imageSlowLoad": {
     "defaultVariant": "off",
     "state": "ENABLED"
   }
   ```

### Action B: Restart Image Provider and Envoy Proxy
If the issue stems from connection pool deadlocks or lingering network socket stalls:
```bash
kubectl rollout restart deployment/image-provider -n otel-demo
kubectl rollout restart deployment/frontend-proxy -n otel-demo
```

### Action C: Scale Image Provider Replicas
If latency is driven by heavy concurrent image requests:
```bash
kubectl scale deployment/image-provider -n otel-demo --replicas=2
```

---

## 5. Verification & Recovery Confirmation

1. Verify that ingress p95 latency drops back below 500ms:
   ```promql
   histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="frontend-proxy", span_name="ingress"}[2m])) by (le)) < 500
   ```
2. Confirm that `ImageSlowLoad` transitions to `resolved` in Prometheus.
3. Open a browser to `http://localhost:8080` and ensure product images render instantaneously.

