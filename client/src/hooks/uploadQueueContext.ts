import { createContext, useContext, useSyncExternalStore } from "react";
import type { UploadQueue, UploadQueueState } from "../lib/uploadQueue";

/** The app's single upload queue, owned by `UploadQueueProvider` in `Layout`. */
export const UploadQueueContext = createContext<UploadQueue | null>(null);

export function useUploadQueue(): { queue: UploadQueue; state: UploadQueueState } {
  const queue = useContext(UploadQueueContext);
  if (!queue) throw new Error("useUploadQueue must be used inside UploadQueueProvider.");
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  return { queue, state };
}
