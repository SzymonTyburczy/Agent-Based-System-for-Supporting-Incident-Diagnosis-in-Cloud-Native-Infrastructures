import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { EmptyCard, ErrorCard, StaleBanner } from "../components/Cards";
import { DocumentViewer } from "../components/DocumentViewer";
import { useDeleteDocument, useDocuments } from "../hooks/useDocuments";
import { useDocumentPanel } from "../hooks/useDocumentPanel";
import { filterDocuments } from "../lib/documentSearch";
import type { KbDocumentSummary } from "../lib/types";

/** A document ingested before file names were recorded goes by its title. */
function documentName(doc: KbDocumentSummary): string {
  return doc.fileName || doc.title || doc.docId;
}

function DocumentRow({
  doc,
  selected,
  deleting,
  deleteDisabled,
  onSelect,
  onDelete,
}: {
  doc: KbDocumentSummary;
  selected: boolean;
  deleting: boolean;
  deleteDisabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const name = documentName(doc);
  const fragments = `${doc.chunkCount} fragment${doc.chunkCount === 1 ? "" : "s"}`;
  const meta = [doc.author, doc.docDate, fragments].filter(Boolean).join(" · ");

  return (
    // Two sibling buttons rather than a delete button nested in a clickable
    // row: a button inside a button is invalid and swallows the inner click.
    <li
      className={[
        "card flex items-center transition-colors",
        selected ? "border-[var(--color-brand)]/60" : "hover:border-[var(--color-brand)]/40",
      ].join(" ")}
    >
      <button
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left"
      >
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand)]" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-white">{name}</span>
          {doc.title && doc.title !== name && (
            <span className="block truncate text-xs text-[var(--color-muted)]">{doc.title}</span>
          )}
          <span className="mt-1 block text-[11px] text-[var(--color-muted)]">{meta}</span>
        </span>
      </button>
      <button
        onClick={onDelete}
        disabled={deleteDisabled}
        aria-label={`Delete ${name}`}
        title="Delete document"
        className="btn-secondary mr-3 shrink-0 text-[var(--color-muted)] hover:text-[var(--color-danger)]"
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </li>
  );
}

export function KnowledgeBasePage() {
  const { documents, loading, refreshing, error, refresh } = useDocuments();
  const { deleteDocument, deletingId, error: deleteError } = useDeleteDocument();
  const { docId: openDocId, nonce, open, close } = useDocumentPanel();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterDocuments(documents, query), [documents, query]);

  const confirmDelete = (doc: KbDocumentSummary) => {
    const confirmed = window.confirm(
      `Delete "${documentName(doc)}" from the knowledge base?\n\n` +
        "The agent will no longer find it in its searches. This cannot be undone.",
    );
    if (!confirmed) return;
    const wasOpen = doc.docId === openDocId;
    const deleteButton = document.activeElement;
    deleteDocument(doc.docId, () => {
      // The focused Delete button leaves with its row, which would drop focus
      // on <body>; the search box keeps the reader in the list instead.
      const active = document.activeElement;
      if (active === deleteButton || active === document.body) searchRef.current?.focus();
      if (wasOpen) close();
    });
  };

  let list: ReactNode;
  if (error && documents.length === 0) {
    list = (
      <ErrorCard title="Couldn't reach the knowledge base." detail={error} onRetry={refresh} />
    );
  } else if (loading) {
    list = <EmptyCard status>Loading documents…</EmptyCard>;
  } else if (documents.length === 0) {
    list = (
      <EmptyCard>
        The knowledge base is empty. Add documents in{" "}
        <Link to="/documentation" className="text-[var(--color-brand)] hover:underline">
          Documentation
        </Link>
        .
      </EmptyCard>
    );
  } else if (visible.length === 0) {
    list = <EmptyCard>No document matches “{query.trim()}”.</EmptyCard>;
  } else {
    list = (
      <ul className="space-y-2">
        {visible.map((doc) => (
          <DocumentRow
            key={doc.docId}
            doc={doc}
            selected={doc.docId === openDocId}
            deleting={doc.docId === deletingId}
            deleteDisabled={deletingId !== null}
            onSelect={() => open(doc.docId)}
            onDelete={() => confirmDelete(doc)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="w-full pb-8">
      <PageHeader
        title="Knowledge base"
        description="The documents the diagnostic agent searches. Open one to read the Markdown it was indexed from."
        actions={
          <button onClick={refresh} disabled={refreshing} className="btn-secondary">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {/* The same two columns as an issue with a cited document open; Layout
          is always wide here (see `isWideRoute`), so selecting a document
          never reflows the page. */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,45%)]">
        <div className="min-w-0 space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by file name or title"
              aria-label="Search documents"
              className="input pl-9"
            />
          </div>

          {deleteError && (
            <div
              role="alert"
              className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
            >
              Couldn't delete the document. {deleteError}
            </div>
          )}

          {/* A failed refresh must not throw away a list that is still on screen. */}
          {error && documents.length > 0 && (
            <StaleBanner
              message="Couldn't refresh from the knowledge base — this list may be stale."
              detail={error}
              onRetry={refresh}
            />
          )}

          {!loading && documents.length > 0 && (
            <p className="text-xs text-[var(--color-muted)]">
              {query.trim()
                ? `${visible.length} of ${documents.length} documents`
                : `${documents.length} document${documents.length === 1 ? "" : "s"}`}
            </p>
          )}

          {list}
        </div>

        {openDocId ? (
          <DocumentViewer docId={openDocId} nonce={nonce} onClose={close} />
        ) : (
          // Only beside the list: stacked under it, a placeholder is just noise.
          <div className="hidden xl:block">
            <EmptyCard>Select a document to read it.</EmptyCard>
          </div>
        )}
      </div>
    </div>
  );
}
