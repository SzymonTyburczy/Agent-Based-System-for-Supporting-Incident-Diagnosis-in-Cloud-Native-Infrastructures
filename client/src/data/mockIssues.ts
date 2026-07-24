import type { Issue } from "../lib/types";

export const mockIssues: Issue[] = [
  {
    id: "INC-1042",
    title: "High latency on checkout API",
    service: "checkout-service",
    severity: "high",
    status: "pending",
    createdAt: "2026-07-13T14:22:00Z",
    summary: "p99 latency exceeds 2s. Suspected database connection pool exhaustion.",
    content: `# INC-1042 — High latency on checkout API

## Symptoms

- p99 latency on \`POST /api/checkout\` exceeds **2s** (SLO: 400ms).
- Alert \`CheckoutLatencyHigh\` firing since 14:10 UTC.
- Error rate stays low (<0.5%) — requests are slow, not failing.

## Telemetry snapshot

| Metric | Value | Baseline |
| --- | --- | --- |
| p99 latency | 2.4s | 380ms |
| DB pool in use | 50/50 | 12/50 |
| CPU (pods avg) | 41% | 35% |

## Suspected cause

Database connection pool exhaustion in \`checkout-service\`. The pool has been
at its maximum (50 connections) since the traffic ramp-up at 14:00 UTC.

\`\`\`
checkout-service | WARN  HikariPool-1 - Connection is not available,
                   request timed out after 30000ms
\`\`\`

## Notes

- Latest deploy of \`checkout-service\` was 3 days ago — unlikely related.
- A marketing campaign started at 14:00 UTC (traffic +60%).`,
  },
  {
    id: "INC-1041",
    title: "OOMKilled pods in recommendation",
    service: "recommendation-service",
    severity: "critical",
    status: "pending",
    createdAt: "2026-07-13T11:05:00Z",
    summary: "Pods restarting due to memory limit exceeded after the latest deployment.",
    content: `# INC-1041 — OOMKilled pods in recommendation

## Symptoms

- Pods of \`recommendation-service\` are repeatedly **OOMKilled** (exit code 137).
- Restart loop started ~20 minutes after the \`v2.14.0\` rollout.
- Recommendations widget returns fallback content for ~35% of requests.

## Kubernetes events

\`\`\`
LAST SEEN   TYPE      REASON      OBJECT                              MESSAGE
2m          Warning   OOMKilling  pod/recommendation-7d9f4c-x2kfp     Memory cgroup out of memory
5m          Warning   BackOff     pod/recommendation-7d9f4c-x2kfp     Back-off restarting failed container
\`\`\`

## Suspected cause

The \`v2.14.0\` release added an in-memory feature cache without a size bound.
Memory usage grows linearly with traffic until the 512Mi limit is hit.

## Notes

- Rollback to \`v2.13.2\` is available.
- Memory limit was last tuned 6 months ago.`,
  },
  {
    id: "INC-1038",
    title: "Spike in 5xx on the API gateway",
    service: "api-gateway",
    severity: "medium",
    status: "resolved",
    createdAt: "2026-07-12T09:40:00Z",
    summary: "Bad routing rule after a deploy. Change rolled back, traffic stabilized.",
    content: `# INC-1038 — Spike in 5xx on the API gateway

## Symptoms

- 5xx rate on the API gateway jumped from 0.1% to **8%** at 09:32 UTC.
- Affected routes: \`/api/orders/*\`, \`/api/payments/*\`.

## Root cause

A routing rule deployed at 09:30 UTC pointed \`/api/orders\` at a service
that does not exist in the \`prod\` namespace (copy-paste from staging config).

## Resolution

- 09:38 UTC — change rolled back.
- 09:40 UTC — 5xx rate back to baseline.

## Follow-ups

- [ ] Add config validation for gateway route targets in CI.
- [ ] Alert on route-level 5xx, not only global.`,
  },
  {
    id: "INC-1035",
    title: "Kafka consumption delays",
    service: "order-processor",
    severity: "low",
    status: "resolved",
    createdAt: "2026-07-11T16:12:00Z",
    summary: "Growing consumer lag. Consumers scaled up, lag back to normal.",
    content: `# INC-1035 — Kafka consumption delays

## Symptoms

- Consumer lag on topic \`orders.events\` grew steadily from 15:40 UTC,
  peaking at **120k messages**.
- Order confirmation emails delayed by up to 25 minutes.

## Root cause

A batch import job produced 3x the usual event volume while the consumer
group was running at its minimum replica count (2).

## Resolution

- Consumers scaled 2 → 6 at 16:05 UTC.
- Lag fully drained by 16:40 UTC.

## Follow-ups

- [ ] Autoscale the consumer group on lag (KEDA).`,
  },
];
