---
requires_any: list_datasources, query_prometheus, query_loki_logs, alerting_manage_rules
---
Grafana:
- Use absolute RFC3339 times like {{now}}, never "now" or "now-30m". Start 15 minutes before the alert.
- Datasource UIDs: one given in this prompt or from {{tool:list_datasources}}; never from alert labels.
- Prometheus names: {{tool:list_prometheus_metric_names}}, {{tool:list_prometheus_label_names}}, {{tool:list_prometheus_label_values}}.
- Loki labels: {{tool:list_loki_label_names}}, {{tool:list_loki_label_values}}.
- Run the alert's expression with {{tool:query_prometheus}} first; split a label-less sum() by a looked-up label.
- {{tool:query_loki_logs}}: filter lines (|= "error"), limit 20.
- {{tool:alerting_manage_rules}}: list only; never change rules.
