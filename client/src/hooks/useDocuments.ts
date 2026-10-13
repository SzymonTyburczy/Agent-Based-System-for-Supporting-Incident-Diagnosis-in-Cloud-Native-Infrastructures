import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentKeys, documentQueryDefaults } from "../lib/documentsCache";
import {
  deleteDocument,
  getDocument,
  isDocumentNotFound,
  listDocuments,
} from "../lib/knowledgeBase";
import type { KbDocument, KbDocumentSummary } from "../lib/types";

export interface UseDocumentsResult {
  /** Newest first, as the server orders them. */
  documents: KbDocumentSummary[];
  /** The first load has not answered yet. */
  loading: boolean;
  /** Any fetch is in flight, the first one or a refresh. */
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The knowledge base's document list. Metadata only — the Markdown of one
 * document is `useDocument`'s job — so the list stays cheap to refetch.
 */
export function useDocuments(): UseDocumentsResult {
  const query = useQuery({
    ...documentQueryDefaults,
    queryKey: documentKeys.list,
    queryFn: ({ signal }) => listDocuments(signal),
  });

  return {
    documents: query.data ?? [],
    loading: query.isPending,
    refreshing: query.isFetching,
    error: query.error ? query.error.message : null,
    refresh: () => void query.refetch(),
  };
}

export type DocumentStatus = "loading" | "ready" | "missing" | "error";

export interface UseDocumentResult {
  document: KbDocument | null;
  /**
   * "missing" when the knowledge base answered 404 — even over a cached copy,
   * because a document deleted since is gone, not merely stale.
   */
  status: DocumentStatus;
  error: string | null;
  retry: () => void;
}

/** One knowledge-base document with its full Markdown, for the viewer panel. */
export function useDocument(docId: string): UseDocumentResult {
  const query = useQuery({
    ...documentQueryDefaults,
    queryKey: documentKeys.detail(docId),
    queryFn: ({ signal }) => getDocument(docId, signal),
    enabled: docId !== "",
  });

  const doc = query.data ?? null;

  let status: DocumentStatus;
  if (isDocumentNotFound(query.error)) status = "missing";
  else if (query.error && !doc) status = "error";
  else status = doc ? "ready" : "loading";

  return {
    document: doc,
    status,
    error: query.error ? query.error.message : null,
    retry: () => void query.refetch(),
  };
}

export interface UseDeleteDocumentResult {
  /**
   * Deletes one document. `onDeleted` runs once the server confirmed and the
   * caches no longer hold it — the place to close a viewer showing it.
   */
  deleteDocument: (docId: string, onDeleted?: () => void) => void;
  /** The document being deleted; null when no delete is in flight. One at a time. */
  deletingId: string | null;
  /** Why the last delete failed, in the server's own words when it gave any. */
  error: string | null;
}

export function useDeleteDocument(): UseDeleteDocumentResult {
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (docId: string) => {
      try {
        await deleteDocument(docId);
      } catch (err) {
        // Already gone — deleted from another tab or by a script — is exactly
        // what the user asked for, so it ends like a successful delete.
        if (!isDocumentNotFound(err)) throw err;
      }
    },
    onSuccess: (_, docId) => {
      // Drop the row now rather than after the refetch, so the list never
      // shows a document the user has just seen deleted.
      client.setQueryData<KbDocumentSummary[]>(documentKeys.list, (list) =>
        list?.filter((doc) => doc.docId !== docId),
      );
      // Removed rather than invalidated: a stale copy would otherwise paint
      // the deleted text when a citation opens it again, until its refetch 404s.
      client.removeQueries({ queryKey: documentKeys.detail(docId), exact: true });
      void client.invalidateQueries({ queryKey: documentKeys.list });
    },
  });

  return {
    deleteDocument: (docId, onDeleted) =>
      mutation.mutate(docId, { onSuccess: () => onDeleted?.() }),
    deletingId: mutation.isPending ? (mutation.variables ?? null) : null,
    error: mutation.error ? mutation.error.message : null,
  };
}
