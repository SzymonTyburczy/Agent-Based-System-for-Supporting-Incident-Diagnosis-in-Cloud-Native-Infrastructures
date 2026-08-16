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
    // so polling it would be noise. A retry covers the case where the panel
    // is opened while the converter is still loading its models.
    staleTime: Infinity,
    retry: 1,
    retryDelay: 3000,
  });

  return data ?? { reachable: false, figureDescriptions: false };
}
