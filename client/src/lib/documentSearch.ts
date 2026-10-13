import type { KbDocumentSummary } from "./types";

/**
 * Lower-cased with diacritics removed, so "lodz" finds "Łódź.md". NFD splits
 * an accented letter into its base letter and a combining mark; "ł" has no
 * such decomposition, so it — the one Polish letter NFD leaves alone — is
 * mapped by hand.
 */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ł/g, "l");
}

/**
 * The knowledge-base search box: every whitespace-separated word of `query`
 * must occur in the document's file name or title, ignoring case and
 * diacritics. A blank query keeps every document. Order is preserved.
 */
export function filterDocuments(docs: KbDocumentSummary[], query: string): KbDocumentSummary[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return docs;

  return docs.filter((doc) => {
    const haystack = fold(`${doc.fileName ?? ""}\n${doc.title}`);
    return words.every((word) => haystack.includes(word));
  });
}
