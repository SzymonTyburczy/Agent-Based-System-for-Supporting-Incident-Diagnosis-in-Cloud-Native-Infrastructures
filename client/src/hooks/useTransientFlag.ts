import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A boolean flag that turns itself off after `durationMs`. Used for "Saved" /
 * "Copied" style confirmations. Re-triggering restarts the timer; the timeout
 * is cleaned up on unmount.
 */
export function useTransientFlag(durationMs: number): {
  flag: boolean;
  trigger: () => void;
  clear: () => void;
} {
  const [flag, setFlag] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setFlag(false);
  }, []);

  const trigger = useCallback(() => {
    clearTimeout(timer.current);
    setFlag(true);
    timer.current = setTimeout(() => setFlag(false), durationMs);
  }, [durationMs]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { flag, trigger, clear };
}
