import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** History-entry state marking the entry our own `open` pushed. */
interface PanelState {
  docPanelPushed?: boolean;
}

function pushedByPanel(state: unknown): boolean {
  return (state as PanelState | null)?.docPanelPushed === true;
}

export interface DocumentPanel {
  /** The `?doc=` of the URL; null while no document is open. */
  docId: string | null;
  /** The `?cite=` key; null for a document opened as a whole. */
  citeKey: string | null;
  /** Bumped by every `open`, so opening what is already shown can scroll to it again. */
  nonce: number;
  open: (docId: string, citeKey?: string | null) => void;
  close: () => void;
}

/**
 * The document viewer panel's state, kept in the URL (`?doc=<id>&cite=<KBn>`)
 * so a cited passage can be linked to and Back closes the panel. Only the
 * first open pushes a history entry; switching documents while the panel is
 * open replaces it, so Back never steps through every citation clicked.
 */
export function useDocumentPanel(): DocumentPanel {
  const location = useLocation();
  const navigate = useNavigate();
  const [nonce, setNonce] = useState(0);

  // `open`/`close` read the location through a ref so their identity survives
  // URL changes: they reach MarkdownPreview's memoised components through
  // `onCite`, and a new identity would remount the chip that was just clicked.
  // A layout effect, so the ref is current before any later click is handled.
  const current = useRef(location);
  useLayoutEffect(() => {
    current.current = location;
  }, [location]);

  // The chip or row that opened the panel, to give focus back to on close.
  const opener = useRef<HTMLElement | null>(null);

  const open = useCallback(
    (docId: string, citeKey: string | null = null) => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) opener.current = active;
      const { search, state } = current.current;
      const params = new URLSearchParams(search);
      const wasOpen = Boolean(params.get("doc"));
      params.set("doc", docId);
      if (citeKey) params.set("cite", citeKey);
      else params.delete("cite");
      navigate(
        `?${params}`,
        wasOpen
          ? { replace: true, state }
          : { state: { docPanelPushed: true } satisfies PanelState },
      );
      setNonce((value) => value + 1);
    },
    [navigate],
  );

  const close = useCallback(() => {
    const { search, state } = current.current;
    // Our own entry: popping it is exactly what Back does. A deep-linked
    // panel has no entry of ours beneath it, so it is closed in place.
    if (pushedByPanel(state)) {
      navigate(-1);
      return;
    }
    const params = new URLSearchParams(search);
    params.delete("doc");
    params.delete("cite");
    navigate(`?${params}`, { replace: true });
  }, [navigate]);

  const params = new URLSearchParams(location.search);
  const docId = params.get("doc") || null;

  // Closing (the panel's button, or Back) unmounts whatever had focus inside
  // the panel, which drops focus on <body> and restarts Tab from the sidebar.
  // Only that case: focus the reader moved elsewhere is left where it is.
  useEffect(() => {
    if (docId !== null) return;
    const target = opener.current;
    opener.current = null;
    const active = document.activeElement;
    if (target?.isConnected && (active === null || active === document.body)) target.focus();
  }, [docId]);

  return {
    docId,
    citeKey: docId ? params.get("cite") || null : null,
    nonce,
    open,
    close,
  };
}
