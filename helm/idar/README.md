# IDAR Helm chart

Installs the IDAR workloads in one release: the diagnostic agent (`agent-core`),
the RAG knowledge base (`rag-server` with Qdrant and Ollama), the PDF converter
(`doc-converter`) and the web panel (`idar-client`). The layout follows
[docs/CLUSTER.md](../../docs/CLUSTER.md).

The monitoring stack and the diagnosed workloads are not part of this chart. They
come from [`example-infrastructure/`](../../example-infrastructure/) (namespaces
`observability` and `otel-demo`).

With the default values the chart renders the same objects as the plain manifests
in [`k8s/`](../../k8s/): same names, ports, probes, resources and security
settings. CI checks this on every pull request (see [Checks](#checks)).

## Before you install

- Kubernetes 1.25 or newer, Helm 3 (or 4), and kubectl.
- Namespace `otel-demo` exists. agent-core gets its read-only Role there.
- Grafana MCP accepts in-cluster callers: `--allowed-hosts` lists
  `grafana-mcp.observability.svc.cluster.local:8000`
  ([grafana-mcp-values.yaml](../../example-infrastructure/values/grafana-mcp-values.yaml)).
  Without it agent-core exits during startup.
- The LLM key is in a Secret. The default provider is Anthropic:

  ```bash
  kubectl create namespace idar
  kubectl label ns idar pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest
  kubectl create secret generic agent-core-secrets -n idar --from-literal=ANTHROPIC_API_KEY=...
  ```

Install into namespace **`idar`**. The panel's Nginx forwards `/api/*` to
`<service>.idar.svc.cluster.local` ([client/nginx.conf](../../client/nginx.conf)),
so in another namespace the panel loads but its API calls fail.

## Install

Default values (images `wpawlina2137/idar-*:v0.2.0` from Docker Hub, no Ingress):

```bash
helm upgrade --install idar ./helm/idar -n idar
kubectl get pods -n idar -w
helm test idar -n idar
```

The first install takes a few minutes. Ollama downloads its models before it
reports Ready, and rag-server waits for it.

To open the panel without an Ingress:

```bash
kubectl port-forward -n idar svc/idar-client 3000:8080
```

Then go to http://localhost:3000.

### Profiles

| File | For |
| --- | --- |
| [`values-local.yaml`](values-local.yaml) | Docker Desktop / kind with images built locally as `idar-*:local` |
| [`values-microk8s-ec2.yaml`](values-microk8s-ec2.yaml) | the microk8s cluster on EC2: Ingress (`public` class) on port 80, hostpath storage |

```bash
helm upgrade --install idar ./helm/idar -n idar -f helm/idar/values-local.yaml

microk8s helm3 upgrade --install idar ./helm/idar -n idar \
  -f helm/idar/values-microk8s-ec2.yaml --set global.panelOrigin=http://<node public IP>
```

Local images have to be imported into the Docker Desktop node first; see
[k8s/README.md, "Docker Desktop (kind)"](../../k8s/README.md#docker-desktop-kind).
The `:local` tags are reused, so after a rebuild run
`kubectl rollout restart deploy/<name> -n idar`.

## Configuration

Every value is documented in [`values.yaml`](values.yaml). The ones you are most
likely to change:

| Value | What it does |
| --- | --- |
| `global.panelOrigin` | The panel's address as the browser sees it. Sets CORS in agent-core, doc-converter and rag-server. |
| `global.imageRegistry`, `global.imageTag` | Registry and tag for the four IDAR images, e.g. ECR. Qdrant and Ollama keep their own. |
| `global.imagePullSecrets` | Pull Secret for a private registry. |
| `global.storageClass` | StorageClass for every volume. `""` = cluster default, `"-"` = none. |
| `agentCore.env` | Agent settings from [agent-core/.env.example](../../agent-core/.env.example): `LLM_PROVIDER`, models, MCP, `AGENT_ENVIRONMENT`. |
| `agentCore.rbac.namespaces` | Namespaces the agent may inspect. Creates the Roles **and** `KUBECTL_ALLOWED_NAMESPACES`. |
| `agentCore.environmentProfile.files` | A custom prompt profile (`environment.md`, optional `fallback_question.md`), mounted from a ConfigMap. |
| `ragServer.embeddingModel` | Ollama embedding model. Ollama downloads it automatically. |
| `ollama.extraModels` | More models to download, e.g. a chat model for the agent. |
| `docConverter.conversionTimeoutSeconds` | The liveness probe adapts to it. |
| `ingress.*` | Ingress in front of the panel. One host is enough. |
| `networkPolicies.enabled` | Lets only rag-server (and agent-core for Ollama) reach Qdrant and Ollama. |
| `<component>.enabled` | Turns a component off, e.g. Ollama when embeddings come from an API. |
| `<component>.resources`, `.nodeSelector`, `.tolerations`, `.affinity` | Sizing and placement. |

Some values are derived so they cannot drift apart:

- `global.panelOrigin` fills all three CORS settings.
- Ollama's download list is `ragServer.embeddingModel`, plus `agentCore.env.OLLAMA_MODEL`
  when `LLM_PROVIDER` is `ollama`, plus `ollama.extraModels`.
- rag-server's startup probe is sized from `startupRetries` × `startupRetrySeconds`.
- doc-converter's liveness tolerance is sized from `conversionTimeoutSeconds`.

A changed ConfigMap or chart-managed Secret restarts the Pods that use it on the
next `helm upgrade`.

### Secrets

Each service reads an optional Secret:

| Secret | Keys |
| --- | --- |
| `agent-core-secrets` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `WEBHOOK_SHARED_SECRET`, `CLIENT_API_TOKEN`, `RAG_API_TOKEN` |
| `rag-server-secrets` | `IDAR_API_TOKEN`, `IDAR_EMBEDDING_API_KEY` |
| `doc-converter-secrets` | `API_TOKEN` |

By default you create them with `kubectl create secret` and the chart only refers
to them. Alternatively set `<component>.secret.create: true` and put the keys in
`<component>.secret.data`. Do that with `--set` or a values file kept **out of git**.

A Secret created with kubectl does not restart anything when it changes; run
`kubectl rollout restart deploy/<name> -n idar`.

## Upgrade and uninstall

```bash
helm upgrade idar ./helm/idar -n idar -f <same values as before>
helm uninstall idar -n idar
```

`helm uninstall` keeps your data:

- `agent-core-data` (reports) and `ollama-models` (downloaded models) are kept
  (`persistence.keep`).
- Qdrant's `storage-qdrant-0` belongs to the StatefulSet and is never deleted by Helm.
- A namespace created by the chart (`namespace.create`) is kept too.

Delete them by hand if you really want a clean slate.

## Moving an existing `kubectl apply -f k8s/` deployment to the chart

The chart uses the same names and selectors, so Helm can take over the running
objects instead of recreating them. This has not been tried on a live cluster yet.

1. Move the LLM key from `agent-core-config` into `agent-core-secrets`.
2. Mark the objects as owned by the release:

   ```bash
   for r in $(kubectl get deploy,statefulset,service,configmap,pvc,serviceaccount,networkpolicy -n idar -l app.kubernetes.io/part-of=idar -o name); do
     kubectl annotate -n idar "$r" meta.helm.sh/release-name=idar meta.helm.sh/release-namespace=idar --overwrite
     kubectl label -n idar "$r" app.kubernetes.io/managed-by=Helm --overwrite
   done
   for r in role/agent-core-reader rolebinding/agent-core-reader; do
     kubectl annotate -n otel-demo "$r" meta.helm.sh/release-name=idar meta.helm.sh/release-namespace=idar --overwrite
     kubectl label -n otel-demo "$r" app.kubernetes.io/managed-by=Helm --overwrite
   done
   ```

   If you also want the chart to own the `local-path` StorageClass
   (`storageClass.create: true`), annotate and label it the same way, without `-n`.

3. Run `helm upgrade --install idar ./helm/idar -n idar` with your values.

## Checks

`helm test idar -n idar` starts one Pod that calls each enabled service's health
endpoint, then the same endpoints through the panel's proxy (`/api/agent`,
`/api/rag`, `/api/converter`). rag-server's `/api/health` also checks Qdrant and runs
an embedding, so it covers Qdrant and Ollama, which the NetworkPolicies close to
the test Pod.

The [`helm-chart`](../../.github/workflows/helm-chart.yaml) workflow runs on every
pull request that touches `helm/` or `k8s/`. It checks three things:

- `helm lint --strict` with the defaults, both profiles and
  [`ci/full-values.yaml`](ci/full-values.yaml), which turns on every optional object;
- the rendered manifests against the Kubernetes API schemas (kubeconform);
- the default render against `k8s/`
  ([compare-with-k8s.py](../scripts/compare-with-k8s.py)). While both exist, a
  change to one has to be made in the other too.

To run the last check locally:

```bash
helm template idar helm/idar -n idar --set namespace.create=true --set storageClass.create=true > rendered.yaml
python helm/scripts/compare-with-k8s.py rendered.yaml k8s
```

## Limitations

- One release per namespace: resource names are fixed because the services, and
  the panel's Nginx, address each other by name.
- The panel needs agent-core, rag-server and doc-converter. Its Nginx resolves
  their Service names when it starts, so with one of them disabled the panel does
  not start.
- agent-core and doc-converter always run one replica with `Recreate`. Their
  state (in-memory queue, SQLite, one Gunicorn worker) does not allow more.
- On microk8s, `hostpath-storage` keeps volume data on the node that ran the Pod.
  Pin Qdrant, Ollama and agent-core to one node (see the profile).
