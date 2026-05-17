# Kubernetes Node Disk Pressure and Log Management

## Overview
`NodeDiskPressure` is a Kubernetes condition set by kubelet when available disk space on a node falls below a threshold (default: 10% free, or `imagefs.available < 15%`). When DiskPressure is `True`, the node is tainted with `node.kubernetes.io/disk-pressure:NoSchedule`, preventing new pods from being scheduled on it.

## Diagnosing Disk Pressure

```bash
# Check node conditions
kubectl describe node <node-name> | grep -A 20 "Conditions:"

# Check disk usage on node (requires node access)
df -h
du -sh /var/lib/kubelet
du -sh /var/log
du -sh /var/lib/docker   # or /var/lib/containerd

# List large container log files
ls -lhS /var/log/containers/ | head -20

# Check PVC usage
kubectl get pvc -A
kubectl df-pv  # requires kubectl-df-pv plugin
```

## Immediate Remediation

### 1. Remove failed and completed pods
```bash
# Delete failed pods
kubectl delete pod --field-selector=status.phase=Failed -A

# Delete completed pods
kubectl delete pod --field-selector=status.phase=Succeeded -A

# Delete evicted pods
kubectl get pods -A | grep Evicted | awk '{print $1 " " $2}' | xargs -n 2 kubectl delete pod -n
```

### 2. Clean up unused container images
```bash
# containerd (most modern clusters)
crictl rmi --prune

# Docker (older clusters)
docker image prune -af
docker system prune -af --volumes
```

### 3. Clean up old log files
```bash
# Compress logs older than 7 days
find /var/log/containers -name "*.log" -mtime +7 -exec gzip -9 {} \;

# Delete compressed logs older than 30 days
find /var/log/containers -name "*.log.gz" -mtime +30 -delete

# Truncate a very large log file (do not delete — container restart would recreate)
truncate -s 0 /var/log/containers/<large-log-file>.log
```

### 4. Expand disk (cloud provider)
```bash
# AWS EBS — resize PVC (if StorageClass supports volume expansion)
kubectl patch pvc <pvc-name> -n <namespace> -p '{"spec": {"resources": {"requests": {"storage": "200Gi"}}}}'

# GKE — resize node disk via node pool configuration
gcloud container node-pools update <pool-name> --cluster=<cluster> --disk-size=200
```

## Configuring Log Rotation

### containerd log rotation
Edit `/etc/containerd/config.toml`:
```toml
[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
```

For containerd-based clusters, configure log rotation via kubelet:
```bash
# Edit /var/lib/kubelet/config.yaml
containerLogMaxSize: "10Mi"
containerLogMaxFiles: 3
```

### Docker log rotation (`/etc/docker/daemon.json`)
```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```
Apply: `systemctl restart docker`

## Centralized Logging (EFK Stack)

To permanently solve log disk pressure, ship logs to a central store and reduce local log retention.

### Fluentd DaemonSet configuration (key settings)
```yaml
# Reduce local buffer size
<buffer>
  @type file
  path /var/log/fluentd-buffers/kubernetes.system.buffer
  flush_mode interval
  flush_interval 5s
  chunk_limit_size 2M
  queue_limit_length 8
  overflow_action block
</buffer>
```

## kubelet Disk Eviction Thresholds

Configure when kubelet starts evicting pods:

```yaml
# /var/lib/kubelet/config.yaml
evictionHard:
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
evictionSoft:
  nodefs.available: "15%"
  nodefs.inodesFree: "10%"
evictionSoftGracePeriod:
  nodefs.available: "1m30s"
evictionMinimumReclaim:
  nodefs.available: "500Mi"
  imagefs.available: "2Gi"
```

## Prevention
- Configure container log rotation (max-size=10m, max-file=3) before deploying to production.
- Deploy centralized logging (EFK or Loki) to avoid accumulating logs locally.
- Set up Prometheus alert: `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.20`
- Use node auto-provisioning or cluster autoscaler with larger disk sizes.
- Regularly clean up unused images with a CronJob on each node.
- Monitor inode usage separately — running out of inodes causes the same symptoms.
