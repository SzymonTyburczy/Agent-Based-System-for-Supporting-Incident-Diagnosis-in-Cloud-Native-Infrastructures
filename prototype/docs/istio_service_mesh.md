# Istio Service Mesh: Traffic Management and Observability

## Overview
Istio is a service mesh that provides traffic management, security, and observability for microservices without requiring application code changes. It uses Envoy sidecar proxies injected into each pod.

## Traffic Management

### VirtualService — Routing and Retries
```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: checkout-service-vs
  namespace: production
spec:
  hosts:
  - checkout-service
  http:
  - timeout: 10s         # Hard timeout for the entire request
    retries:
      attempts: 3
      perTryTimeout: 3s  # Timeout per attempt
      retryOn: 5xx,reset,connect-failure,retriable-4xx
    route:
    - destination:
        host: checkout-service
        port:
          number: 8080
```

### DestinationRule — Circuit Breaking and Load Balancing
```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: payment-service-dr
  namespace: production
spec:
  host: payment-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
        connectTimeout: 3s
        tcpKeepalive:
          time: 7200s
          interval: 75s
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        idleTimeout: 90s
    loadBalancer:
      simple: LEAST_CONN
    outlierDetection:               # Circuit breaking
      consecutive5xxErrors: 5       # Eject after 5 consecutive 5xx
      consecutiveGatewayErrors: 5
      interval: 30s                 # Evaluation interval
      baseEjectionTime: 30s        # Minimum ejection duration
      maxEjectionPercent: 50        # Max % of hosts to eject
      minHealthPercent: 30          # Min % healthy to trigger ejection
```

## Observability

### Distributed Tracing with Jaeger
```bash
# Install Jaeger add-on
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.20/samples/addons/jaeger.yaml

# Access Jaeger UI
istioctl dashboard jaeger
```

### Kiali Service Graph
```bash
# Install Kiali
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.20/samples/addons/kiali.yaml

# Access Kiali UI
istioctl dashboard kiali
```

## Debugging with Istio

```bash
# Check Envoy proxy configuration
istioctl proxy-config cluster <pod-name>.<namespace>
istioctl proxy-config endpoint <pod-name>.<namespace>
istioctl proxy-config route <pod-name>.<namespace>

# Check for configuration errors
istioctl analyze -n production

# View access logs for a specific pod
kubectl logs <pod-name> -n production -c istio-proxy | tail -100

# Check mutual TLS status
istioctl authn tls-check <pod-name> -n production
```

## Common Istio Issues

### 503 errors - upstream connect error
Usually indicates the circuit breaker is open or connection pool is exhausted:
```bash
# Check Envoy stats
kubectl exec <pod> -n production -c istio-proxy -- pilot-agent request GET stats | grep "overflow\|pending\|retry\|circuit"
```

### High latency due to mTLS overhead
Ensure mTLS is configured with PERMISSIVE mode during migration:
```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: PERMISSIVE  # Allow both mTLS and plaintext
```
