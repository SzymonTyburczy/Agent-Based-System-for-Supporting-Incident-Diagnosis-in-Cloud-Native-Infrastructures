{{/*
Shared helpers. Component templates call them with a dict:
  (dict "ctx" $ "name" "agent-core" "component" "diagnostic-agent")
*/}}

{{- define "idar.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{/*
Labels on every resource. app.kubernetes.io/name is the component name, as in
k8s/, so Services and NetworkPolicies select the same Pods.
*/}}
{{- define "idar.labels" -}}
app.kubernetes.io/name: {{ .name }}
{{- with .component }}
app.kubernetes.io/component: {{ . }}
{{- end }}
app.kubernetes.io/part-of: idar
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ include "idar.chart" .ctx }}
{{- end }}

{{/*
Pod template labels: no chart version, so a chart bump alone does not restart
every Pod.
*/}}
{{- define "idar.podLabels" -}}
app.kubernetes.io/name: {{ .name }}
{{- with .component }}
app.kubernetes.io/component: {{ . }}
{{- end }}
app.kubernetes.io/part-of: idar
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- end }}

{{/*
Selector: the component name only, exactly as in k8s/. Selectors are immutable,
so keeping them identical lets a release adopt Deployments that were applied
with kubectl (see the chart README).
*/}}
{{- define "idar.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
{{- end }}

{{/*
Image reference. Call with (dict "ctx" $ "image" .Values.x.image "idar" true).
For the IDAR images ("idar" true) global.imageRegistry and global.imageTag win
over the component's own registry and tag.
*/}}
{{- define "idar.image" -}}
{{- $registry := .image.registry | default "" -}}
{{- $tag := .image.tag | toString -}}
{{- if .idar -}}
{{- $registry = .ctx.Values.global.imageRegistry | default $registry -}}
{{- $tag = .ctx.Values.global.imageTag | default $tag | toString -}}
{{- end -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $registry) .image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end }}

{{- define "idar.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
Container securityContext required by the namespace's Pod Security
"restricted" profile. Writable paths are explicit volumes.
*/}}
{{- define "idar.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/*
nodeSelector / tolerations / affinity of one component's values.
*/}}
{{- define "idar.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
storageClassName for a PVC. Call with (dict "ctx" $ "persistence" .Values.x.persistence).
"" = cluster default (field omitted), "-" = storageClassName: "".
*/}}
{{- define "idar.storageClassName" -}}
{{- $sc := .persistence.storageClass | default .ctx.Values.global.storageClass -}}
{{- if eq $sc "-" }}
storageClassName: ""
{{- else if $sc }}
storageClassName: {{ $sc | quote }}
{{- end }}
{{- end }}

{{/*
In-cluster URLs. Short names: every IDAR workload runs in the same namespace.
*/}}
{{- define "idar.qdrantUrl" -}}
http://qdrant:6333
{{- end }}

{{- define "idar.ollamaUrl" -}}
http://ollama:11434
{{- end }}

{{- define "idar.ragServerUrl" -}}
http://rag-server:8080
{{- end }}

{{/*
Models ollama pulls: rag-server's embedding model, the agent's model when it
runs on Ollama, and ollama.extraModels — de-duplicated, space-separated.
*/}}
{{- define "idar.ollama.models" -}}
{{- $models := list -}}
{{- if .Values.ragServer.enabled -}}
{{- $models = append $models .Values.ragServer.embeddingModel -}}
{{- end -}}
{{- if and .Values.agentCore.enabled (eq (.Values.agentCore.env.LLM_PROVIDER | default "") "ollama") .Values.agentCore.env.OLLAMA_MODEL -}}
{{- $models = append $models .Values.agentCore.env.OLLAMA_MODEL -}}
{{- end -}}
{{- range .Values.ollama.extraModels -}}
{{- $models = append $models . -}}
{{- end -}}
{{- $models | uniq | join " " -}}
{{- end }}

{{/*
Secret data written by the chart (create: true). Call with the component's
secret values.
*/}}
{{- define "idar.secret" -}}
{{- if .secret.create }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ .secret.name }}
  namespace: {{ .ctx.Release.Namespace }}
  labels:
    {{- include "idar.labels" (dict "ctx" .ctx "name" .name) | nindent 4 }}
type: Opaque
stringData:
  {{- range $key, $value := .secret.data }}
  {{ $key }}: {{ $value | toString | quote }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
ConfigMap data from a map of settings, every value quoted as a string (keys
come out sorted, so the checksum is stable).
*/}}
{{- define "idar.envData" -}}
{{- $lines := list -}}
{{- range $key, $value := . -}}
{{- $lines = append $lines (printf "%s: %s" $key ($value | toString | quote)) -}}
{{- end -}}
{{- join "\n" $lines -}}
{{- end }}

{{/*
Pod annotation that rolls the Pod when its ConfigMap or chart-managed Secret
changes. Call with (dict "config" <rendered data> "secret" <secret values>).
*/}}
{{- define "idar.checksums" -}}
checksum/config: {{ .config | sha256sum }}
{{- if and .secret .secret.create }}
checksum/secret: {{ toYaml .secret.data | sha256sum }}
{{- end }}
{{- end }}

{{/*
envFrom entry for a component's Secret. Optional: the Pod starts without it,
as with the plain manifests.
*/}}
{{- define "idar.secretRef" -}}
- secretRef:
    name: {{ .name }}
    optional: {{ not .create }}
{{- end }}
