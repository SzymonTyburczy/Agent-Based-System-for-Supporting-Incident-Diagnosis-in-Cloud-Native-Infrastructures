/**
 * Whether `Layout` should drop its `max-w-6xl` cap: true where a document
 * viewer sits beside the page's content and needs the room — always on the
 * knowledge base, and on an issue while a cited document is open (`?doc=`).
 * Takes `location.pathname` / `location.search` as given by react-router.
 */
export function isWideRoute(pathname: string, search: string): boolean {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/knowledge-base") return true;
  return /^\/issues\/[^/]+$/.test(path) && Boolean(new URLSearchParams(search).get("doc"));
}
