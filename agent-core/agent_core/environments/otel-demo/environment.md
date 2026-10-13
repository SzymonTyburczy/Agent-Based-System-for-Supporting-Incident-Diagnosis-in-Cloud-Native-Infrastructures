Environment: OpenTelemetry Demo shop, namespace otel-demo.
- Prometheus datasource UID: prometheus.
- Checkout gRPC errors: rpc_server_duration_milliseconds_count{job=~".*checkout.*", rpc_grpc_status_code!="0"}.
