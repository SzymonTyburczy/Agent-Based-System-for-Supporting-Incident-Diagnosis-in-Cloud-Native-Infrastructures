# Runbook: FrontendHighRequestRate — Abnormally High Request Volume on Homepage

| Metadata | Details |
| :--- | :--- |
| **Alert Name** | `FrontendHighRequestRate` |
| **Severity** | `Warning` (P2) |
| **Target Service** | `frontend` (Next.js / Node.js) |
| **Namespace** | `otel-demo` |
| **PromQL Rule** | `sum(rate(traces_span_metrics_calls_total{service_name="frontend", span_name="GET /"}[2m])) > 2` |
| **Threshold** | Incoming request rate on `GET /` exceeds 2.0 req/s for more than 1 minute (`for: 1m`) |
| **Last Updated** | 2026-11-21 |

---

## 1. Overview & Problem Description

The `FrontendHighRequestRate` alert triggers when the request throughput hitting the Astronomy Shop homepage (`GET /`) exceeds 2 requests per second continuously over a 2-minute sliding window.

Under typical baseline traffic in the demo environment, simulated customer browsing generates approximately 0.15–0.30 req/s for the root endpoint `GET /`. When this rate spikes above 2 req/s, the frontend server is subjected to aggressive page requests, leading to increased server-side rendering (SSR) load, thread pool saturation, and elevated memory and CPU consumption across frontend pods.

### Business & User Impact
* Risk of frontend SSR starvation leading to slow initial page rendering times.
* Potential cascading saturation on downstream services called during homepage rendering (e.g. `product-catalog`, `recommendation`, `currency`, and `ad` services).
* Degraded responsiveness for genuine concurrent shoppers.

---

## 2. Immediate Triage & Diagnostics

When paged by this alert, execute these diagnostic steps:

### Step 1: Assess Homepage Request Rate in Prometheus
Check the current rate of incoming requests to the homepage:
```promql
sum(rate(traces_span_metrics_calls_total{service_name="frontend", span_name="GET /"}[2m]))
```
Compare with overall frontend ingress traffic:
```promql
sum(rate(traces_span_metrics_calls_total{service_name="frontend-proxy", span_name="ingress"}[2m]))
```

### Step 2: Check Frontend Pod Resource Consumption
Evaluate whether the flood is overwhelming pod resources:
```bash
kubectl top pod -n otel-demo -l app.kubernetes.io/component=frontend
kubectl get pods -n otel-demo -l app.kubernetes.io/component=frontend
```

### Step 3: Inspect Upstream Traffic Source and Generator
Check logs on the frontend and the `load-generator` deployment:
```bash
kubectl logs -n otel-demo -l app.kubernetes.io/component=frontend --tail=100
kubectl logs -n otel-demo -l app.kubernetes.io/component=load-generator --tail=100
```
Look for:
* Continuous rapid GET requests to `/` originating from simulated Locust user agents (`User-Agent: Locust...`).
* External scraping bots or repeated health-check loops.

---

## 3. Potential Root Causes

1. **Synthetic Traffic Flood Feature Flag Active (`loadGeneratorFloodHomepage`):**
   * The load generator incorporates a saturation feature flag named **`loadGeneratorFloodHomepage`** managed by Flagd.
   * When this flag is enabled (`on`), Locust workers continuously flood the `/` root homepage endpoint without think-time or pacing, generating ~8–12 req/s on the homepage.
   * *Check:* Verify active feature flags in Flagd configuration:
     ```bash
     kubectl get configmap flagd-config -n otel-demo -o yaml
     ```
     Look for `"loadGeneratorFloodHomepage": { "defaultVariant": "on" }`.
2. **Aggressive Web Crawlers, Scrapers, or DoS Conditions:**
   * External unthrottled bots or misconfigured uptime probes continuously hammering the homepage without caching.
3. **Marketing Campaign or Sudden Organic Traffic Spike:**
   * Legitimate burst in traffic from promotional events or newsletter dispatches.

---

## 4. Remediation & Action Plan

### Action A: Deactivate `loadGeneratorFloodHomepage` Flag (Fastest Fix)
If the flood is originating from the simulated load generator test scenario:
1. Open the Feature Flags UI (`http://localhost:8080/feature-flags`) or edit `flagd-config`:
   ```bash
   kubectl edit configmap flagd-config -n otel-demo
   ```
2. Set the `defaultVariant` for `loadGeneratorFloodHomepage` to `off`:
   ```json
   "loadGeneratorFloodHomepage": {
     "defaultVariant": "off",
     "state": "ENABLED"
   }
   ```
3. The load generator will reload the flag configuration and resume normal pacing within seconds.

### Action B: Restart Load Generator (If Flag Sync Stalls)
If Locust processes do not immediately acknowledge flag updates:
```bash
kubectl rollout restart deployment/load-generator -n otel-demo
```

### Action C: Scale Frontend Replicas (For Genuine High Traffic)
If traffic represents genuine user demand:
```bash
kubectl scale deployment/frontend -n otel-demo --replicas=4
```

---

## 5. Verification & Recovery Confirmation

1. Verify that `GET /` request rate drops back to baseline (< 0.5 req/s):
   ```promql
   sum(rate(traces_span_metrics_calls_total{service_name="frontend", span_name="GET /"}[2m])) < 0.5
   ```
2. Confirm that `FrontendHighRequestRate` alert status changes from `firing` $\rightarrow$ `resolved`.
3. Check that frontend pod CPU utilization settles back below 0.20 vCPU.

