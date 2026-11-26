# Runbook: KafkaConsumerLag — Processing Lag in Fraud Detection Consumer

| Metadata | Details |
| :--- | :--- |
| **Alert Name** | `KafkaConsumerLag` |
| **Severity** | `Critical` (P1) |
| **Target Service** | `fraud-detection` (Java / Spring Kafka consumer) & `kafka` |
| **Namespace** | `otel-demo` |
| **PromQL Rule** | `max(kafka_consumer_records_lag_max) > 2 or histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="fraud-detection", span_name="orders process"}[2m])) by (le)) > 500` |
| **Threshold** | Consumer record lag exceeds 2 messages or p95 processing time exceeds 500ms for over 1 minute (`for: 1m`) |
| **Last Updated** | 2026-11-21 |

---

## 1. Overview & Problem Description

The `KafkaConsumerLag` alert fires when the asynchronous order processing pipeline between Kafka and the `fraud-detection` microservice falls behind. This occurs either because the maximum record lag on the consumer group exceeds 2 messages or the 95th percentile latency of the consumer processing span (`orders process`) exceeds 500ms continuously for over 60 seconds.

In standard operation, `fraud-detection` processes newly placed order events off the `orders` Kafka topic in under 10ms with zero lag. When lag builds up, order validation stalls, downstream accounting updates are postponed, and fraudulent activity checks are delayed.

### Business & User Impact
* Delay in real-time fraud scoring for newly completed orders.
* Backpressure on Kafka topic partitions, leading to eventual disk saturation if unaddressed.
* Desynchronization between order placement and fulfillment systems.

---

## 2. Immediate Triage & Diagnostics

When paged by this alert, execute these diagnostic steps:

### Step 1: Verify Consumer Lag and Processing Latency in Prometheus
Check the current consumer lag metric:
```promql
max(kafka_consumer_records_lag_max)
```
Check the 95th percentile processing duration in `fraud-detection`:
```promql
histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="fraud-detection", span_name="orders process"}[2m])) by (le))
```
Check order consumption throughput:
```promql
sum(rate(kafka_consumer_records_consumed_total[2m]))
```

### Step 2: Inspect Consumer Pod and Kafka Cluster Health
```bash
kubectl get pods -n otel-demo -l app.kubernetes.io/component=fraud-detection
kubectl get pods -n otel-demo -l app.kubernetes.io/component=kafka
kubectl top pod -n otel-demo -l app.kubernetes.io/component=fraud-detection
```

### Step 3: Check Consumer Service Logs for Blocking Operations
```bash
kubectl logs -n otel-demo -l app.kubernetes.io/component=fraud-detection --tail=100
```
Look for:
* Thread sleep pauses, blocking I/O calls, or simulated lag warnings.
* Consumer rebalance storms: `CommitFailedException` or `Revoking assigned partitions`.
* Deserialization failures or database lookup timeouts.

---

## 3. Potential Root Causes

1. **Processing Thread Contention / Blocking Operations in Consumer:**
   * Synchronous I/O operations, slow remote fraud database lookups, or unoptimized evaluation algorithms blocking the Kafka poll loop.
2. **Kafka Partition Rebalancing or Offset Commit Timeouts:**
   * If message processing duration exceeds `max.poll.interval.ms`, Kafka coordinator marks the consumer dead and triggers repeated rebalancing.
3. **Sudden Order Ingestion Spikes Exceeding Consumption Capacity:**
   * Upstream promotional campaigns creating order generation surges faster than a single consumer thread can process.
4. **Chaos / Synthetic Pipeline Degradation:**
   * In testing environments, automated chaos experiments or pipeline degradation flags (e.g. `kafkaQueueProblems` in Flagd) intentionally throttle consumer throughput by introducing synthetic sleep cycles.

---

## 4. Remediation & Action Plan

### Action A: Check Configuration and Pipeline Flags
1. Check Flagd configuration for active consumer throttle flags:
   ```bash
   kubectl get configmap flagd-config -n otel-demo -o yaml
   ```
2. If `kafkaQueueProblems` is set to `on`, disable it via the Feature Flags dashboard (`http://localhost:8080/feature-flags`) or patch `flagd-config`:
   ```json
   "kafkaQueueProblems": {
     "defaultVariant": "off",
     "state": "ENABLED"
   }
   ```

### Action B: Restart Fraud Detection Consumer
If the consumer is stuck in a zombie rebalance state or deadlocked poll loop:
```bash
kubectl rollout restart deployment/fraud-detection -n otel-demo
kubectl rollout status deployment/fraud-detection -n otel-demo
```

### Action C: Scale Consumer Replicas (If Partitions Allow)
If genuine incoming order volume exceeds single consumer capacity:
```bash
kubectl scale deployment/fraud-detection -n otel-demo --replicas=2
```

---

## 5. Verification & Recovery Confirmation

1. Verify that `kafka_consumer_records_lag_max` returns to 0:
   ```promql
   max(kafka_consumer_records_lag_max) <= 1
   ```
2. Confirm that consumer processing p95 latency drops back below 50ms:
   ```promql
   histogram_quantile(0.95, sum(rate(traces_span_metrics_duration_milliseconds_bucket{service_name="fraud-detection", span_name="orders process"}[2m])) by (le)) < 50
   ```
3. Verify that `KafkaConsumerLag` alert resolves in Prometheus.

