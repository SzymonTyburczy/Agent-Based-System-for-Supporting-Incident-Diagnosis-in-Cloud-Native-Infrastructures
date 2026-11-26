"""Check that the chart's default render matches the plain manifests in k8s/.

While both exist, a change to one of them must reach the other. Render the
chart with the options that k8s/ always applies, then compare object by object:

    helm template idar helm/idar -n idar \
      --set namespace.create=true --set storageClass.create=true > rendered.yaml
    python helm/scripts/compare-with-k8s.py rendered.yaml k8s

Helm-only metadata (instance, managed-by and chart labels, checksum and
resource-policy annotations) and the chart's test hook are ignored. Exits 1 on
any difference not listed in EXPECTED. Needs PyYAML.
"""

import glob
import json
import os
import sys

import yaml

HELM_LABELS = {"app.kubernetes.io/instance", "app.kubernetes.io/managed-by", "helm.sh/chart"}
HELM_ANNOTATION_PREFIXES = ("checksum/", "helm.sh/")

# Differences made on purpose: (kind, namespace, name) -> paths.
EXPECTED = {
    # The key belongs in the agent-core-secrets Secret, not a ConfigMap.
    ("ConfigMap", "idar", "agent-core-config"): {".data.ANTHROPIC_API_KEY"},
    # The chart labels everything it owns.
    ("StorageClass", "", "local-path"): {".metadata.labels"},
}


def load(paths):
    objects = {}
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for doc in yaml.safe_load_all(f):
                if not doc:
                    continue
                annotations = doc["metadata"].get("annotations") or {}
                if "helm.sh/hook" in annotations:
                    continue
                key = (doc["kind"], doc["metadata"].get("namespace", ""), doc["metadata"]["name"])
                objects[key] = normalize(doc)
    return objects


def clean_metadata(meta):
    meta = dict(meta)
    labels = {k: v for k, v in (meta.pop("labels", None) or {}).items() if k not in HELM_LABELS}
    annotations = {
        k: v
        for k, v in (meta.pop("annotations", None) or {}).items()
        if not k.startswith(HELM_ANNOTATION_PREFIXES)
    }
    if labels:
        meta["labels"] = labels
    if annotations:
        meta["annotations"] = annotations
    return meta


def normalize(obj):
    if isinstance(obj, dict):
        obj = {k: normalize(v) for k, v in obj.items()}
        if isinstance(obj.get("metadata"), dict):
            obj["metadata"] = clean_metadata(obj["metadata"])
        return obj
    if isinstance(obj, list):
        return [normalize(v) for v in obj]
    return obj


def diff(helm, k8s, path=""):
    """Yields (path, description) for every difference."""
    if type(helm) is not type(k8s):
        yield path, f"helm={json.dumps(helm)} k8s={json.dumps(k8s)}"
    elif isinstance(helm, dict):
        for key in sorted(set(helm) | set(k8s)):
            sub = f"{path}.{key}"
            if key not in helm:
                yield sub, f"only in k8s: {json.dumps(k8s[key])[:200]}"
            elif key not in k8s:
                yield sub, f"only in helm: {json.dumps(helm[key])[:200]}"
            else:
                yield from diff(helm[key], k8s[key], sub)
    elif isinstance(helm, list):
        if len(helm) != len(k8s):
            yield path, f"{len(helm)} items in helm, {len(k8s)} in k8s"
        for i, (a, b) in enumerate(zip(helm, k8s)):
            yield from diff(a, b, f"{path}[{i}]")
    elif helm != k8s:
        yield path, f"helm={json.dumps(helm)} k8s={json.dumps(k8s)}"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    helm = load([sys.argv[1]])
    k8s = load(sorted(glob.glob(os.path.join(sys.argv[2], "*.yaml"))))

    problems = 0
    for key in sorted(set(helm) | set(k8s)):
        if key not in helm:
            print(f"only in k8s/:  {key}")
            problems += 1
            continue
        if key not in k8s:
            print(f"only in chart: {key}")
            problems += 1
            continue
        lines = [(p, d) for p, d in diff(helm[key], k8s[key]) if p not in EXPECTED.get(key, set())]
        if lines:
            print(f"differs: {key}")
            for path, description in lines:
                print(f"  {path}: {description}")
            problems += 1

    if problems:
        print(f"\n{problems} object(s) differ between the chart and k8s/.")
        sys.exit(1)
    print(f"chart matches k8s/ ({len(helm)} objects).")


if __name__ == "__main__":
    main()
