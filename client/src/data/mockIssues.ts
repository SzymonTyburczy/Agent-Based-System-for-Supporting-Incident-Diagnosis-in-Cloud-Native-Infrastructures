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
  },
  {
    id: "INC-1041",
    title: "OOMKilled pods in recommendation",
    service: "recommendation-service",
    severity: "critical",
    status: "pending",
    createdAt: "2026-07-13T11:05:00Z",
    summary: "Pods restarting due to memory limit exceeded after the latest deployment.",
  },
  {
    id: "INC-1038",
    title: "Spike in 5xx on the API gateway",
    service: "api-gateway",
    severity: "medium",
    status: "resolved",
    createdAt: "2026-07-12T09:40:00Z",
    summary: "Bad routing rule after a deploy. Change rolled back, traffic stabilized.",
  },
  {
    id: "INC-1035",
    title: "Kafka consumption delays",
    service: "order-processor",
    severity: "low",
    status: "resolved",
    createdAt: "2026-07-11T16:12:00Z",
    summary: "Growing consumer lag. Consumers scaled up, lag back to normal.",
  },
];
