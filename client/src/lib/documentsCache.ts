import type { QueryKey } from "@tanstack/react-query";
import { isDocumentNotFound } from "./knowledgeBase";

/** Query keys of the knowledge-base documents. Invalidating `all` covers the
 * list and every cached document. */
export const documentKeys = {
  all: ["documents"] as QueryKey,
  list: ["documents", "list"] as QueryKey,
  detail: (id: string) => ["documents", "detail", id] as QueryKey,
};

/**
 * Spread into every documents query. The app-wide `staleTime: Infinity` is
 * right only for reports, which the SSE stream keeps fresh; nothing pushes
 * knowledge-base changes (an ingest from another tab or a script), so a view
 * older than this refetches when it is next mounted.
 */
export const documentQueryDefaults = {
  staleTime: 30_000,
  // As in the global default, a 404 is an answer — "this document is gone" —
  // not a hiccup to retry; the global rule only recognises the agent's errors.
  retry: (failureCount: number, error: Error) => !isDocumentNotFound(error) && failureCount < 1,
};
