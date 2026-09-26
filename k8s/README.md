# Kubernetes manifests for IDAR

Plain manifests for the IDAR workloads in namespace `idar`, following the layout
proposed in [docs/CLUSTER.md](../docs/CLUSTER.md). One file per workload; each file
starts with a header describing what it needs and why it is shaped the way it is.

| File | Workload | Needs |
| --- | --- | --- |
| `00-namespace.yaml` | namespace `idar` (Pod Security `restricted`) | — |
| `qdrant.yaml` | vector store (StatefulSet + volume) | namespace |
| `ollama.yaml` | embedding engine (Deployment + model volume) | namespace |
| `rag-server.yaml` | RAG knowledge base API | Qdrant, Ollama |
| `doc-converter.yaml` | PDF → Markdown | namespace |
| `agent-core.yaml` | diagnostic agent + RBAC in `otel-demo` | Grafana MCP accepting in-cluster callers, an LLM |
| `client.yaml` | web panel | the three APIs above, at browser-reachable URLs |

The monitoring stack and the diagnosed workloads are not here: they come from
`example-infrastructure/` (Helm charts in namespaces `observability` and `otel-demo`).

## Deploy

```bash
kubectl apply -f k8s/
kubectl get pods -n idar -w
```

`00-namespace.yaml` sorts first, so one command is enough. The first deploy takes a
few minutes: Ollama pulls the embedding model before it reports ready, and
rag-server waits for it (its startup window is sized for that). Nothing needs to be
started in a particular order.

## Images

The four IDAR images are built from this repository, with the tags the manifests use:

```bash
docker build --build-arg KUBECTL_VERSION=v1.34.3 -t idar-agent-core:local ./agent-core
docker build -t idar-doc-converter:local ./doc-converter
docker build -t idar-rag-server:local ./server
docker build --build-arg VITE_AGENT_API_URL=... --build-arg VITE_CONVERTER_URL=... --build-arg VITE_RAG_API_URL=... -t idar-client:local ./client
```

Match `KUBECTL_VERSION` to the cluster. The client's `VITE_*` URLs are what the
browser calls, see the header of `client.yaml`.

### Docker Desktop (kind)

The kind node does not see images from the local Docker store: a Pod on
`idar-rag-server:local` fails with `ErrImageNeverPull` / `ErrImagePull`. Import each
image into the node's containerd through a node debug Pod:

```bash
docker save idar-rag-server:local -o rag-server.tar
kubectl debug node/desktop-control-plane --profile=sysadmin --image=busybox:1.36 -- sleep 600
kubectl cp rag-server.tar <node-debugger-pod>:/host/tmp/rag-server.tar
kubectl exec <node-debugger-pod> -- chroot /host ctr -n k8s.io images import /tmp/rag-server.tar
kubectl exec <node-debugger-pod> -- rm /host/tmp/rag-server.tar
kubectl delete pod <node-debugger-pod>
```

Use `kubectl cp` with a relative local path: an absolute Windows path (`C:\...`) is
read as a Pod name, and piping the tarball through `kubectl exec -i` is cut short on
Windows. The import is fast because Docker Desktop's containerd store already holds
the layers.

The tags are reused (`:local`, `imagePullPolicy: IfNotPresent`), so after a rebuild
the cluster keeps running the old image until you import the new one **and** restart
the Deployment (`kubectl rollout restart deploy/<name> -n idar`). Check with
`kubectl get pod -n idar -o jsonpath='{..imageID}'` when in doubt.

### EC2 / ECR

Push the images to a registry the nodes can pull from and replace the image names,
for example:

```bash
sed -i 's#image: idar-\(.*\):local#image: <account>.dkr.ecr.<region>.amazonaws.com/idar-\1:<tag>#' k8s/*.yaml
```

Volumes use the default StorageClass; on EC2 install the EBS CSI driver first, or the
claims of Qdrant, Ollama and agent-core stay `Pending`.

## Configuration and secrets

Non-secret settings are in each workload's ConfigMap. CORS origins default to
`http://localhost:3000`, the local panel port from
[docs/CONTAINERS.md](../docs/CONTAINERS.md); set the panel's real origin in
`agent-core-config`, `doc-converter-config` and `rag-server-config`.

Secrets are never committed. Every Secret is optional at the Kubernetes level; create
the ones your configuration needs:

| Secret | Keys | When |
| --- | --- | --- |
| `agent-core-secrets` | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, `WEBHOOK_SHARED_SECRET`, `CLIENT_API_TOKEN` | the default `LLM_PROVIDER=openai` needs its key, or the agent exits at startup |
| `rag-server-secrets` | `IDAR_API_TOKEN` | to require a bearer token on the RAG API |
| `doc-converter-secrets` | `API_TOKEN` | to require a bearer token on `/convert` |

```bash
kubectl create secret generic agent-core-secrets -n idar --from-literal=OPENAI_API_KEY=...
```

Changing a ConfigMap or Secret does not reach running Pods: restart the Deployment.

## Local access

There is no Ingress yet (it needs real host names, TLS and a controller). Use
port-forwards on the ports the panel was built with:

```bash
kubectl port-forward -n idar svc/idar-client 3000:8080
kubectl port-forward -n idar svc/agent-core 8090:8080
kubectl port-forward -n idar svc/doc-converter 5001:5001
kubectl port-forward -n idar svc/rag-server 8100:8080
```

If one of these ports is taken on your machine, use another one, build the panel with
matching `VITE_*` URLs and add its origin to the three CORS settings above.

## Security notes

- The namespace enforces the Pod Security `restricted` profile: every container runs
  as non-root with a read-only root filesystem, no privilege escalation and all
  capabilities dropped. Writable paths are explicit volumes (`/tmp`, `$HOME`, data).
- `qdrant.yaml` and `ollama.yaml` include NetworkPolicies that admit only their
  clients. They are accepted everywhere but enforced only by a network plugin that
  implements NetworkPolicy (Calico, Cilium, AWS VPC CNI with network policies
  enabled). Docker Desktop's kind networking does not enforce them.
- agent-core's ServiceAccount can only `get`/`list`/`watch` pods and events in
  `otel-demo`; everything else is `Forbidden`.
