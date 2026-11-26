# Runbook: PaymentServiceFailure — High Error Rate in Payment Service

| Metadata | Details |
| :--- | :--- |
| **Alert Name** | `PaymentServiceFailure` |
| **Severity** | `Critical` (P1) |
| **Target Service** | `payment` (Node.js microservice) |
| **Namespace** | `otel-demo` |
| **PromQL Rule** | `sum(rate(traces_span_metrics_calls_total{service_name="payment", span_kind="SPAN_KIND_SERVER", span_name=~".*Charge.*", status_code="STATUS_CODE_ERROR"}[5m])) > 0.01` |
| **Threshold** | Server-side error rate on `Charge` RPC exceeds 0.01 req/s for over 1 minute (`for: 1m`) |
| **Last Updated** | 2026-11-21 |

---

## 1. Overview & Problem Description

The `PaymentServiceFailure` alert triggers when the `payment` microservice fails to process customer transactions via its gRPC `Charge` endpoint. Specifically, server-side spans reporting `STATUS_CODE_ERROR` exceed the baseline threshold over a 5-minute sliding window.

Under normal operational conditions, the checkout pipeline successfully charges customer credit cards with a near-zero error rate. When this alert fires, checkout transactions fail, orders cannot be completed, and customers receive payment error banners during order finalization.

### Business & User Impact
* Direct loss of revenue: Customers cannot complete checkouts.
* Abandoned shopping carts and increased checkout drop-off rates.
* Cascading transaction cancellations across `checkout` and `accounting` services.

---

## 2. Immediate Triage & Diagnostics

When paged by this alert, execute the following triage steps immediately:

### Step 1: Verify Error Rates and Trends in Prometheus
Assess the current rate of failed charges:
```promql
sum(rate(traces_span_metrics_calls_total{service_name="payment", span_kind="SPAN_KIND_SERVER", span_name=~".*Charge.*", status_code="STATUS_CODE_ERROR"}[5m]))
```
Compare total vs error call rate to determine failure percentage:
```promql
sum(rate(traces_span_metrics_calls_total{service_name="payment", span_name=~".*Charge.*", status_code="STATUS_CODE_ERROR"}[5m])) 
/ 
sum(rate(traces_span_metrics_calls_total{service_name="payment", span_name=~".*Charge.*"}[5m]))
```

### Step 2: Check Pod Status and Restarts
```bash
kubectl get pods -n otel-demo -l app.kubernetes.io/component=payment
kubectl describe pod -n otel-demo -l app.kubernetes.io/component=payment
```

### Step 3: Inspect Payment Service Logs
Fetch recent logs from the `payment` pod to identify the exact error message or stack trace:
```bash
kubectl logs -n otel-demo -l app.kubernetes.io/component=payment --tail=100
```
Look for:
* Artificial failure rejections: `Failed to charge card: Simulated failure` or `Credit card transaction failed`.
* Upstream validation rejections: `Invalid credit card number` or `Unsupported currency`.
* Uncaught exceptions or connection timeouts to external payment gateways.

---

## 3. Potential Root Causes

1. **Experimental Chaos / Feature Flag Toggled (`paymentFailure`):**
   * The application includes a deliberate failure-injection feature flag named **`paymentFailure`** configured via Flagd.
   * When this flag is enabled (e.g. set to `100%`, `50%`, `25%`, or `10%`), the payment service artificially rejects a designated percentage of incoming `Charge` requests.
   * *Check:* Inspect the active feature flags in Flagd configuration:
     ```bash
     kubectl get configmap flagd-config -n otel-demo -o yaml
     ```
     Or open the Feature Flags UI at `http://localhost:8080/feature-flags` and check whether `paymentFailure` is active.
2. **Invalid Payment Credentials / Card Processor Validation:**
   * Malformed credit card numbers or expired tokens passed from upstream checkout flows.
3. **Database or External Payment Gateway Network Failure:**
   * Downstream banking APIs or simulated card gateways unreachable due to network partition or DNS failure.

---

## 4. Remediation & Action Plan

### Action A: Disable the `paymentFailure` Feature Flag (Fastest Fix)
If the failures are caused by active chaos/fault testing:
1. Open the Feature Flags UI (`http://localhost:8080/feature-flags`) or edit `flagd-config`:
   ```bash
   kubectl edit configmap flagd-config -n otel-demo
   ```
2. Set the `defaultVariant` for `paymentFailure` to `off`:
   ```json
   "paymentFailure": {
     "defaultVariant": "off",
     "state": "ENABLED"
   }
   ```
3. Flagd automatically syncs updates to connected pods within seconds.

### Action B: Restart Payment Service
If the service has locked handles or persistent internal connection failures:
```bash
kubectl rollout restart deployment/payment -n otel-demo
kubectl rollout status deployment/payment -n otel-demo
```

---

## 5. Verification & Recovery Confirmation

1. Check that the error rate drops back to 0:
   ```promql
   sum(rate(traces_span_metrics_calls_total{service_name="payment", span_kind="SPAN_KIND_SERVER", span_name=~".*Charge.*", status_code="STATUS_CODE_ERROR"}[5m])) == 0
   ```
2. Verify in Prometheus that `PaymentServiceFailure` transitions from `firing` $\rightarrow$ `resolved`.
3. Complete a manual test purchase through the Astronomy Shop web UI to verify end-to-end checkout.

