import { useEffect } from "react";

type Args = {
  enabled?: boolean;
  intervalMs?: number;
  requestRowsRefresh: (mode?: "tick" | "snapshot") => void;
};

export function useExecutionMarketRefresh({
  enabled = true,
  intervalMs = 5_000,
  requestRowsRefresh,
}: Args) {
  useEffect(() => {
    if (!enabled) return;

    requestRowsRefresh("tick");

    const timer = window.setInterval(() => {
      requestRowsRefresh("tick");
    }, Math.max(1_000, intervalMs));

    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, requestRowsRefresh]);
}
