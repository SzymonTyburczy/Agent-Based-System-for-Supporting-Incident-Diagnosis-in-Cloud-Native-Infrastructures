import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { convertToMarkdown } from "../lib/converter";
import { documentKeys } from "../lib/documentsCache";
import { ingestDocument } from "../lib/knowledgeBase";
import { getDefaultAuthor } from "../lib/settings";
import { UploadQueue } from "../lib/uploadQueue";
import { UploadQueueContext } from "../hooks/uploadQueueContext";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Owns the upload queue for the app's lifetime. Mounted once, in `Layout`, so
 * files keep converting and sending while the user is on another page.
 */
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [queue] = useState(
    () =>
      new UploadQueue({
        convert: convertToMarkdown,
        ingest: ingestDocument,
        defaultAuthor: getDefaultAuthor,
        now: () => new Date(),
        // `all`, not just the list: re-sending a document added before the
        // server kept originals and file names upgrades it in place, so a
        // cached copy of it may be stale too.
        onKnowledgeBaseChanged: () => void client.invalidateQueries({ queryKey: documentKeys.all }),
        storage: browserStorage(),
      }),
  );

  useEffect(() => {
    queue.start();
  }, [queue]);

  useEffect(() => {
    const flush = () => queue.flush();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") queue.flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [queue]);

  // A file waiting for or in conversion exists only in memory — a reload loses
  // it, so the browser asks first.
  const { items } = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const holdsFiles = items.some((item) => item.stage === "queued" || item.stage === "converting");
  useEffect(() => {
    if (!holdsFiles) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [holdsFiles]);

  return <UploadQueueContext.Provider value={queue}>{children}</UploadQueueContext.Provider>;
}
