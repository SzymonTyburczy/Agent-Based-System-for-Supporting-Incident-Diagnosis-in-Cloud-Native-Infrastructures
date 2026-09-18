import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeToReportEvents, type StreamStatus } from "../lib/api";
import { cacheReport, reportKeys } from "../lib/reportsCache";
import { StreamStatusContext } from "../hooks/streamContext";

/**
 * Owns the app's single EventSource and feeds what it receives straight into
 * the query cache. Mounted once, in `Layout`.
 */
export function ReportsStream({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const openedOnce = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeToReportEvents({
      onReport: (report) => cacheReport(client, report),
      onStatus: (next) => {
        setStatus(next);
        if (next !== "live") return;
        // Resync after a reconnect. Not polish: ReportEventBroadcaster.publish
        // drops a subscriber's OLDEST pending event once its 32-slot queue is
        // full, so a briefly-disconnected client provably misses updates that
        // only a refetch repairs.
        if (openedOnce.current) void client.invalidateQueries({ queryKey: reportKeys.all });
        openedOnce.current = true;
      },
    });
    return unsubscribe;
  }, [client]);

  return <StreamStatusContext.Provider value={status}>{children}</StreamStatusContext.Provider>;
}
