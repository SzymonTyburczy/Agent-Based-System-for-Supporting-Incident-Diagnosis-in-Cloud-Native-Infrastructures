import { useQuery } from "@tanstack/react-query";
import { getConverterUrl } from "../lib/settings";

export interface ConverterHealth {
  /** The service answered. */
  reachable: boolean;
  /** A vision model is configured on the SERVICE, not in this browser. */
  figureDescriptions: boolean;
}

/**
 * Reads the converter's own `/healthz`. The client no longer holds any model
 * key — it only reports what the service says about itself.
 */
export function useConverterHealth(): ConverterHealth {
  const { data } = useQuery({
    queryKey: ["converter", "health"],
    queryFn: async (): Promise<ConverterHealth> => {
      const baseUrl = getConverterUrl();
      if (!baseUrl) return { reachable: false, figureDescriptions: false };

      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { reachable: false, figureDescriptions: false };

      const body = (await response.json()) as { figure_descriptions?: unknown };
      return { reachable: true, figureDescriptions: body.figure_descriptions === true };
    },
    // The service is started by hand and its config only changes on restart,
    // so polling would be noise. No retry either: the converter does not bind
    // its port until the models are loaded, so an early check is refused
    // outright and no realistic delay would cover a 60-110 s start. The dialog
    // tells the user to start it and reload.
    staleTime: Infinity,
    retry: false,
  });

  return data ?? { reachable: false, figureDescriptions: false };
}
