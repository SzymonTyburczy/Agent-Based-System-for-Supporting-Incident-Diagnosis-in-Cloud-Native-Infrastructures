"""
Mock telemetry data, incident scenarios, and RAG documentation snippets.
Each scenario simulates realistic cloud-native infrastructure data.
"""

SCENARIOS: dict[str, dict] = {
    "high_cpu": {
        "id": "high_cpu",
        "name": "High CPU Usage",
        "alert_type": "CPUThrottlingHigh",
        "severity": "critical",
        "namespace": "production",
        "service": "api-gateway",
        "description": "CPU usage exceeded 95% threshold on multiple pods for over 10 minutes.",
        "metrics": {
            "cpu_usage_percent": 98.2,
            "cpu_throttle_percent": 87.5,
            "pod_count": 3,
            "affected_pods": ["api-gateway-7d9f4b-xk2p9", "api-gateway-7d9f4b-mn3tz", "api-gateway-7d9f4b-qr8ls"],
            "node": "gke-prod-node-pool-1-abc123",
            "memory_usage_mb": 1842,
            "memory_limit_mb": 2048,
            "requests_per_second": 2847,
            "avg_response_time_ms": 1243,
        },
        "logs": [
            "[2024-01-15 10:23:11] WARN  api-gateway - Request queue depth: 847 (threshold: 100)",
            "[2024-01-15 10:23:14] ERROR api-gateway - Timeout processing request /api/v1/orders after 30000ms",
            "[2024-01-15 10:23:15] WARN  api-gateway - CPU throttling detected, reducing worker threads from 16 to 4",
            "[2024-01-15 10:23:18] ERROR api-gateway - Circuit breaker OPEN for downstream service: inventory-service",
            "[2024-01-15 10:23:20] WARN  kubelet - CPU limit exceeded for container api-gateway, throttling applied",
            "[2024-01-15 10:23:45] ERROR api-gateway - OOMKill risk: memory pressure detected alongside CPU starvation",
        ],
        "rag_docs": [
            {
                "source": "Kubernetes Best Practices - Resource Management",
                "content": "CPU throttling occurs when a container exceeds its CPU limit. This causes CFS (Completely Fair Scheduler) throttling. Symptoms include increased latency, timeout errors, and reduced throughput. Resolution: increase CPU limits, optimize application code, or scale horizontally via HPA.",
            },
            {
                "source": "GKE Performance Tuning Guide",
                "content": "For high-traffic API gateways, consider using CPU request/limit ratio of 1:2 at minimum. Enable Horizontal Pod Autoscaler (HPA) with CPU utilization target of 70%. Consider using Burstable QoS class for variable workloads.",
            },
            {
                "source": "Kubernetes HPA Documentation",
                "content": "HPA scales pods based on observed CPU utilization. Configure with: kubectl autoscale deployment api-gateway --cpu-percent=70 --min=3 --max=10. Ensure metrics-server is deployed in the cluster.",
            },
        ],
    },
    "db_timeout": {
        "id": "db_timeout",
        "name": "Database Connection Timeout",
        "alert_type": "DatabaseConnectionFailed",
        "severity": "critical",
        "namespace": "production",
        "service": "postgres-primary",
        "description": "Database connection pool exhausted. New connections timing out after 30s.",
        "metrics": {
            "active_connections": 100,
            "max_connections": 100,
            "waiting_connections": 47,
            "idle_connections": 0,
            "connection_timeout_ms": 30000,
            "query_duration_p99_ms": 8423,
            "replication_lag_seconds": 0.2,
            "database_size_gb": 284.7,
        },
        "logs": [
            "[2024-01-15 11:05:02] ERROR postgres - remaining connection slots are reserved for non-replication superuser connections",
            "[2024-01-15 11:05:03] ERROR app-service - FATAL: connection pool timeout after 30000ms waiting for connection",
            "[2024-01-15 11:05:04] WARN  pgbouncer - Client queue depth: 47 (max_client_conn=100 reached)",
            "[2024-01-15 11:05:05] ERROR app-service - could not connect to server: Connection refused - Is the server running?",
            "[2024-01-15 11:05:10] WARN  postgres - autovacuum: found 1847 dead tuples in relation app.orders - VACUUM recommended",
            "[2024-01-15 11:05:12] ERROR app-service - Transaction rolled back due to connection loss: ORDER_ID=8472910",
        ],
        "rag_docs": [
            {
                "source": "PostgreSQL Connection Pooling Best Practices",
                "content": "When max_connections is reached, new connections are rejected. Use PgBouncer in transaction-pooling mode to handle thousands of app connections with fewer database connections. Recommended pool_size = CPU_cores * 2 + disk_spindles.",
            },
            {
                "source": "PostgreSQL Tuning Guide",
                "content": "Increase max_connections carefully as each connection uses ~5-10MB of RAM. Alternatively, set idle_in_transaction_session_timeout to kill idle transactions. Use pg_stat_activity to identify long-running or idle queries.",
            },
            {
                "source": "Cloud Database Scaling Patterns",
                "content": "For connection exhaustion, consider: 1) Read replicas for read-heavy workloads, 2) Connection pooler (PgBouncer/Pgpool-II), 3) Vertical scaling of the database instance, 4) Query optimization to reduce connection hold time.",
            },
        ],
    },
    "oomkill": {
        "id": "oomkill",
        "name": "Memory Leak (OOMKill)",
        "alert_type": "KubePodOOMKilled",
        "severity": "warning",
        "namespace": "staging",
        "service": "ml-inference-service",
        "description": "Pod repeatedly OOMKilled due to memory leak in ML model inference cache.",
        "metrics": {
            "memory_usage_mb": 4096,
            "memory_limit_mb": 4096,
            "oom_kill_count": 7,
            "pod_restarts": 7,
            "uptime_before_kill_minutes": 23,
            "heap_used_mb": 3847,
            "heap_total_mb": 4000,
            "gc_pause_ms_p99": 2847,
            "cache_size_items": 184729,
        },
        "logs": [
            "[2024-01-15 09:12:00] INFO  ml-inference - Model loaded: bert-large-uncased (1.2GB), cache initialized",
            "[2024-01-15 09:25:11] WARN  ml-inference - Inference cache growing rapidly: 50,000 items (TTL not enforced)",
            "[2024-01-15 09:31:44] WARN  ml-inference - Heap usage at 85% (3482MB / 4096MB)",
            "[2024-01-15 09:34:02] WARN  ml-inference - GC pressure: major GC cycles every 12 seconds",
            "[2024-01-15 09:35:10] ERROR kubelet - OOMKilling process ml-inference, pid=1842, memory.limit_in_bytes=4294967296",
            "[2024-01-15 09:35:10] WARN  kubernetes - Back-off restarting failed container ml-inference in pod ml-inference-service-6d8f9b-tt2kp",
        ],
        "rag_docs": [
            {
                "source": "Kubernetes Memory Management Guide",
                "content": "OOMKill occurs when a container exceeds its memory limit. The Linux OOM killer terminates the process. To prevent: set appropriate memory limits, implement cache eviction policies, use memory profiling tools like pprof or async-profiler.",
            },
            {
                "source": "ML Model Serving Best Practices",
                "content": "ML inference services often suffer from unbounded caches. Implement LRU caching with max_size limits. For PyTorch/TensorFlow: use torch.cuda.empty_cache() periodically. Consider using Redis for distributed caching instead of in-process caches.",
            },
            {
                "source": "JVM/Python Memory Tuning",
                "content": "For Python services: use memory_profiler to identify leaks. Common causes: circular references, global caches without TTL, large pandas DataFrames held in memory. Use objgraph library to visualize object growth.",
            },
        ],
    },
    "cascade_failure": {
        "id": "cascade_failure",
        "name": "Service Cascade Failure",
        "alert_type": "ServiceUnavailable",
        "severity": "critical",
        "namespace": "production",
        "service": "checkout-service",
        "description": "Cascade failure originating from payment-service timeout, spreading to checkout and order services.",
        "metrics": {
            "error_rate_percent": 94.7,
            "http_503_count_per_minute": 1847,
            "affected_services": ["checkout-service", "order-service", "notification-service"],
            "upstream_latency_ms": 45000,
            "circuit_breaker_state": "OPEN",
            "retry_storm_rps": 4200,
            "dependency_timeout_ms": 45000,
        },
        "logs": [
            "[2024-01-15 14:02:01] ERROR payment-service - External payment gateway timeout after 30000ms",
            "[2024-01-15 14:02:05] WARN  checkout-service - payment-service returned HTTP 503, retrying (attempt 1/3)",
            "[2024-01-15 14:02:35] ERROR checkout-service - payment-service unavailable after 3 retries, circuit breaker triggered",
            "[2024-01-15 14:02:36] ERROR order-service - checkout-service returned HTTP 503, cascade detected",
            "[2024-01-15 14:02:37] WARN  checkout-service - Retry storm detected: 4200 RPS hitting payment-service",
            "[2024-01-15 14:02:40] CRITICAL alertmanager - SLO breach: checkout error rate 94.7% (threshold: 1%)",
        ],
        "rag_docs": [
            {
                "source": "Microservices Resilience Patterns",
                "content": "Cascade failures occur when a slow/failed dependency causes resource exhaustion upstream. Mitigation: Circuit Breaker pattern (Hystrix, Resilience4j), Bulkhead pattern to isolate failures, timeout + retry with exponential backoff, fallback mechanisms.",
            },
            {
                "source": "Istio Service Mesh - Traffic Management",
                "content": "Use Istio VirtualService to configure timeouts and retries: spec.http[].timeout, spec.http[].retries. Enable circuit breaking via DestinationRule: outlierDetection with consecutive5xxErrors and ejectionPercent settings.",
            },
            {
                "source": "Google SRE Book - Managing Cascading Failures",
                "content": "To stop a cascade: 1) Drop traffic via load shedding, 2) Disable non-critical features, 3) Increase timeouts temporarily while fixing root cause, 4) Use feature flags to bypass failing dependencies, 5) Implement graceful degradation.",
            },
        ],
    },
    "disk_pressure": {
        "id": "disk_pressure",
        "name": "Disk Space Critical",
        "alert_type": "NodeDiskPressure",
        "severity": "warning",
        "namespace": "kube-system",
        "service": "etcd",
        "description": "Node disk usage at 94%. etcd data directory growing due to uncompacted revision history.",
        "metrics": {
            "disk_usage_percent": 94.2,
            "disk_used_gb": 188.4,
            "disk_total_gb": 200,
            "disk_free_gb": 11.6,
            "etcd_db_size_gb": 8.2,
            "etcd_db_size_in_use_gb": 2.1,
            "pvc_usage_percent": 87.3,
            "log_directory_size_gb": 45.7,
            "inode_usage_percent": 91.0,
        },
        "logs": [
            "[2024-01-15 08:30:00] WARN  etcd - Database size 8.2GB approaching quota 8.0GB - compaction needed",
            "[2024-01-15 08:30:01] WARN  kubelet - Node condition DiskPressure=True threshold exceeded",
            "[2024-01-15 08:30:02] WARN  scheduler - Node gke-prod-node-1 has DiskPressure taint, skipping for scheduling",
            "[2024-01-15 08:30:05] ERROR etcd - mvcc: database space exceeded - apply will panic",
            "[2024-01-15 08:30:06] WARN  kube-apiserver - etcd cluster is unhealthy: https://10.0.0.1:2379 - timed out",
            "[2024-01-15 08:31:00] WARN  fluentd - Log file rotation failed: no space left on device /var/log/containers",
        ],
        "rag_docs": [
            {
                "source": "etcd Operations Guide - Compaction",
                "content": "etcd stores all history by default. Run compaction: etcdctl compact $(etcdctl endpoint status --write-out=json | jq '.[0].Status.header.revision'). Then defragment: etcdctl defrag. This reclaims disk space from the fragmented etcd database.",
            },
            {
                "source": "Kubernetes Node Disk Management",
                "content": "DiskPressure taint prevents scheduling new pods on affected node. Immediate actions: 1) Remove old container images: crictl rmi --prune, 2) Clean up evicted pods: kubectl delete pod --field-selector=status.phase=Failed -A, 3) Rotate and compress logs.",
            },
            {
                "source": "Kubernetes Log Management with Fluentd",
                "content": "Configure log rotation in /etc/docker/daemon.json: {\"log-opts\": {\"max-size\": \"10m\", \"max-file\": \"3\"}}. For Kubernetes: use logrotate with container runtime log paths. Consider using a centralized logging solution (EFK stack) to avoid local disk pressure.",
            },
        ],
    },
}
