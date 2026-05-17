# Kubernetes Memory Management and OOMKill Prevention

## Overview
The Linux OOM (Out of Memory) Killer terminates processes when the system runs out of memory. In Kubernetes, when a container exceeds its memory limit, it is immediately OOMKilled. Unlike CPU throttling (which slows the container), OOMKill terminates the container, causing a pod restart.

## Understanding OOMKill

### Detection
```bash
# Check for OOMKilled containers
kubectl get pods -n <namespace> -o json | jq '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason == "OOMKilled") | .metadata.name'

# Check pod restart history
kubectl describe pod <pod-name> -n <namespace> | grep -A 10 "Last State"

# Check OOMKill events
kubectl get events -n <namespace> --field-selector reason=OOMKilling

# Check OOMKill count metric (Prometheus)
kube_pod_container_status_restarts_total
```

### System-level OOMKill detection
```bash
# Check kernel OOM log
dmesg | grep -i "oom\|out of memory\|killed process"
journalctl -k | grep -i oom
```

## Diagnosing Memory Leaks

### Tools by language/runtime

**Python**:
```bash
pip install memory-profiler objgraph
# Profile memory usage
python -m memory_profiler your_script.py
# Find objects growing in memory
import objgraph
objgraph.show_growth(limit=10)
```

**Node.js**:
```bash
# Use --inspect flag and Chrome DevTools heap snapshot
node --inspect app.js
# Or use clinic.js
npx clinic heapprofile -- node app.js
```

**JVM (Java/Scala/Kotlin)**:
```bash
# Take heap dump
jcmd <pid> GC.heap_dump /tmp/heapdump.hprof
# Analyze with Eclipse Memory Analyzer (MAT)
# Or use async-profiler
java -agentpath:/path/to/libasyncProfiler.so=start,event=alloc,file=profile.html
```

**Go**:
```bash
# Use pprof
go tool pprof http://localhost:6060/debug/pprof/heap
```

## Memory Leak Patterns

### Unbounded in-process caches
```python
# PROBLEMATIC: No eviction policy
cache = {}
def get_inference(input_text):
    if input_text not in cache:
        cache[input_text] = model.infer(input_text)  # grows forever
    return cache[input_text]

# FIXED: LRU cache with max size
from functools import lru_cache
@lru_cache(maxsize=10_000)
def get_inference(input_text):
    return model.infer(input_text)
```

### ML Model serving memory issues
- **Problem**: Model weights loaded multiple times, inference result cache without TTL.
- **Fix**: Load models once at startup, use `torch.cuda.empty_cache()` periodically, implement Redis for distributed caching.

## Kubernetes Memory Configuration

### Set appropriate limits
```yaml
resources:
  requests:
    memory: "2Gi"   # Set to p95 usage + 20% buffer
  limits:
    memory: "4Gi"   # Set to maximum acceptable usage
```

### Quality of Service (QoS) classes
- **Guaranteed**: requests == limits. Never OOMKilled unless node is under pressure (use for critical services).
- **Burstable**: requests < limits. OOMKilled when exceeding limit.
- **BestEffort**: No requests/limits set. First to be OOMKilled under node pressure.

### Enable VPA for memory right-sizing
```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ml-inference-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ml-inference-service
  updatePolicy:
    updateMode: "Off"  # Recommendation only, apply manually
  resourcePolicy:
    containerPolicies:
    - containerName: ml-inference
      minAllowed:
        memory: "1Gi"
      maxAllowed:
        memory: "8Gi"
```

## Prevention
- Monitor `container_memory_working_set_bytes` and alert at 80% of limit.
- Profile memory usage under load before setting production limits.
- Implement cache TTL and max-size policies from the start.
- Use sidecar containers (e.g., Prometheus JMX exporter) to expose JVM GC metrics.
- Set `terminationGracePeriodSeconds` appropriately to allow graceful shutdown before OOMKill.
