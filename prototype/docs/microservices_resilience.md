# Microservices Resilience Patterns: Circuit Breaker and Cascade Failure Prevention

## Overview
Cascade failures occur when a failure in one downstream service propagates upstream, causing resource exhaustion (thread pool, connection pool, memory) in the calling services. A single slow dependency can bring down an entire microservice ecosystem through retry storms and queue saturation.

## Circuit Breaker Pattern

The circuit breaker monitors calls to a downstream service and "opens" (stops forwarding calls) when the error rate or latency exceeds a threshold. This gives the downstream time to recover without being overwhelmed by retry traffic.

### States
- **Closed**: Requests flow normally. Error rate is tracked.
- **Open**: All requests fail immediately (fast-fail). No calls to downstream.
- **Half-Open**: A limited number of test requests are allowed through to check recovery.

### Implementation with Resilience4j (Java)
```yaml
resilience4j:
  circuitbreaker:
    instances:
      payment-service:
        registerHealthIndicator: true
        slidingWindowSize: 10
        minimumNumberOfCalls: 5
        permittedNumberOfCallsInHalfOpenState: 3
        automaticTransitionFromOpenToHalfOpenEnabled: true
        waitDurationInOpenState: 30s
        failureRateThreshold: 50
        slowCallRateThreshold: 50
        slowCallDurationThreshold: 5s
```

### Implementation with Istio Service Mesh
```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: payment-service-circuit-breaker
spec:
  host: payment-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 100
      minHealthPercent: 0
```

## Retry Storm Prevention

### Exponential Backoff with Jitter
```python
import random
import time

def retry_with_backoff(func, max_retries=3, base_delay=1.0):
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            # Exponential backoff with full jitter
            delay = base_delay * (2 ** attempt)
            jitter = random.uniform(0, delay)
            time.sleep(jitter)
```

### Istio Retry Configuration
```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: checkout-service
spec:
  hosts:
  - checkout-service
  http:
  - timeout: 10s
    retries:
      attempts: 3
      perTryTimeout: 3s
      retryOn: 5xx,reset,connect-failure
```

## Bulkhead Pattern

Isolate resources for different services to prevent one slow service from consuming all available threads/connections.

```yaml
# Thread pool isolation per downstream dependency
resilience4j:
  bulkhead:
    instances:
      payment-service:
        maxConcurrentCalls: 10
        maxWaitDuration: 0ms
      inventory-service:
        maxConcurrentCalls: 20
        maxWaitDuration: 0ms
```

## Stopping an Active Cascade Failure

### Immediate actions (< 5 minutes)
1. **Enable load shedding**: Return HTTP 503 immediately for non-critical paths.
2. **Disable retries**: Set retry count to 0 to stop retry storms.
3. **Feature flags**: Disable the feature calling the failing downstream.
4. **Traffic reduction**: Reduce incoming traffic via load balancer or API gateway rate limiting.

```bash
# Scale down problematic caller to reduce load on downstream
kubectl scale deployment checkout-service --replicas=1 -n production

# Add rate limiting annotation (nginx-ingress)
kubectl annotate ingress checkout-ingress nginx.ingress.kubernetes.io/limit-rps="10"
```

### Graceful degradation
Return cached or default responses instead of calling the failing service:
```python
def get_payment_status(order_id):
    try:
        return payment_service.get_status(order_id)
    except CircuitOpenException:
        # Return cached last-known status
        return cache.get(f"payment_status:{order_id}") or {"status": "pending", "source": "cache"}
```

## Prevention Checklist
- [ ] Circuit breakers configured for all downstream dependencies
- [ ] Timeouts set on all outbound HTTP/gRPC calls (never use default infinite timeout)
- [ ] Retry with exponential backoff + jitter (never immediate retry)
- [ ] Bulkheads configured to isolate dependency failures
- [ ] Fallback responses implemented for all critical paths
- [ ] Load shedding configured at the API gateway level
- [ ] Distributed tracing (Jaeger/Zipkin) deployed to quickly identify failure origin
