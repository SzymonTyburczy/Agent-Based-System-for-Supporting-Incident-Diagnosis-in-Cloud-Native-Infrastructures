# etcd Operations: Compaction, Defragmentation, and Disk Management

## Overview
etcd is the key-value store backing Kubernetes. It stores all cluster state: pods, services, configmaps, secrets, and more. etcd keeps a complete revision history of every key-value change. Without regular compaction, the database grows unbounded, eventually exceeding its size quota (default 2GB, often configured to 8GB) and causing `mvcc: database space exceeded` errors, which makes the entire Kubernetes API server unavailable.

## Understanding etcd Storage

### Database size vs in-use size
- **DB size**: Physical size of the database file (includes historical revisions).
- **DB size in use**: Size of currently active data.
- The gap between these two is fragmented space that can be reclaimed via defragmentation.

### Check etcd health and size
```bash
# Export etcdctl environment
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS="https://127.0.0.1:2379"
export ETCDCTL_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
export ETCDCTL_CERT="/etc/kubernetes/pki/etcd/server.crt"
export ETCDCTL_KEY="/etc/kubernetes/pki/etcd/server.key"

# Check endpoint status (shows DB size and leader)
etcdctl endpoint status --write-out=table

# Check endpoint health
etcdctl endpoint health
```

## Compaction (Remove Historical Revisions)

Compaction removes all historical revisions up to a given revision, freeing logical space.

```bash
# Get current revision
CURRENT_REVISION=$(etcdctl endpoint status --write-out=json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Status']['header']['revision'])")
echo "Current revision: $CURRENT_REVISION"

# Compact up to current revision
etcdctl compact $CURRENT_REVISION

# Alternative: compact keeping last 1000 revisions
COMPACT_REVISION=$((CURRENT_REVISION - 1000))
etcdctl compact $COMPACT_REVISION
```

## Defragmentation (Reclaim Physical Disk Space)

After compaction, the database file still holds fragmented space. Defragmentation rewrites the database file, reclaiming this space.

**Warning**: Defragmentation causes a brief etcd unavailability (~1-2 seconds per member). Always defragment followers first, then the leader.

```bash
# Defragment all members (one at a time for HA)
for ENDPOINT in $(etcdctl member list --write-out=json | python3 -c "import sys,json; [print(m['clientURLs'][0]) for m in json.load(sys.stdin)['members']]"); do
    echo "Defragmenting $ENDPOINT..."
    etcdctl defrag --endpoints=$ENDPOINT
    sleep 5
done

# Or defragment single endpoint
etcdctl defrag --endpoints=https://10.0.0.1:2379
```

## Emergency: Database Space Exceeded

When `mvcc: database space exceeded` occurs, the cluster is in alarm state and read-only.

```bash
# Step 1: Compact immediately
CURRENT_REVISION=$(etcdctl endpoint status --write-out=json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Status']['header']['revision'])")
etcdctl compact $CURRENT_REVISION

# Step 2: Defragment
etcdctl defrag

# Step 3: Disarm the alarm
etcdctl alarm disarm

# Verify alarm is cleared
etcdctl alarm list
```

## Node Disk Pressure: Immediate Actions

```bash
# Clean up completed/failed pods
kubectl delete pod --field-selector=status.phase=Failed -A
kubectl delete pod --field-selector=status.phase=Succeeded -A

# Remove unused container images
crictl rmi --prune
# or for Docker
docker image prune -af

# Check large directories
du -sh /var/lib/kubelet/*
du -sh /var/log/containers/*

# Compress old logs
find /var/log/containers -name "*.log" -mtime +7 -exec gzip {} \;

# Check PVC usage
kubectl get pvc -A
```

## Configuring etcd Auto-Compaction

Prevent manual compaction by enabling automatic compaction in the etcd configuration:

```yaml
# /etc/kubernetes/manifests/etcd.yaml (kubeadm cluster)
spec:
  containers:
  - command:
    - etcd
    - --auto-compaction-mode=revision
    - --auto-compaction-retention=1000   # Keep last 1000 revisions
    # Or periodic:
    # - --auto-compaction-mode=periodic
    # - --auto-compaction-retention=1h   # Compact every hour
    - --quota-backend-bytes=8589934592   # 8GB quota
```

## Prevention
- Enable `--auto-compaction-retention` in etcd configuration.
- Monitor `etcd_mvcc_db_total_size_in_bytes` in Prometheus.
- Alert when DB size > 70% of quota.
- Run defragmentation during maintenance windows (weekly).
- Monitor node disk usage with alert at 80%.
- Configure log rotation for container logs: max-size=10m, max-file=3.
