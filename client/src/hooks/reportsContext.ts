import { createContext, useContext, type Dispatch } from "react";
import type { ReportsAction, ReportsState } from "../lib/reportsState";

export interface ReportsStore {
  state: ReportsState;
  dispatch: Dispatch<ReportsAction>;
  /** Re-issues `GET /reports`, aborting any in-flight one. */
  refresh: () => void;
}

export const ReportsContext = createContext<ReportsStore | null>(null);

export function useReportsStore(): ReportsStore {
  const store = useContext(ReportsContext);
  if (!store) throw new Error("useReportsStore must be used inside <ReportsProvider>");
  return store;
}
