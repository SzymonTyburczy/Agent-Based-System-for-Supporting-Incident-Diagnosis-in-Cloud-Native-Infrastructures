import { createContext, useContext } from "react";
import type { StreamStatus } from "../lib/api";

export const StreamStatusContext = createContext<StreamStatus>("connecting");

export function useStreamStatus(): StreamStatus {
  return useContext(StreamStatusContext);
}
