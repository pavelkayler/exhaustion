import { useEffect, useMemo, useState } from "react";
import type { StreamsState } from "../../../shared/types/domain";

type StableStreamsMode = "off" | "connected" | "reconnecting";

function toMode(streams: StreamsState): StableStreamsMode {
  if (!streams.streamsEnabled) return "off";
  return streams.bybitConnected ? "connected" : "reconnecting";
}

export function useStableStreamsStatus(streams: StreamsState, reconnectHoldMs = 8_000) {
  const rawMode = useMemo(() => toMode(streams), [streams]);
  const [displayMode, setDisplayMode] = useState<StableStreamsMode>(rawMode);

  useEffect(() => {
    if (rawMode === "off" || rawMode === "connected") {
      setDisplayMode(rawMode);
      return;
    }
    const timer = window.setTimeout(() => {
      setDisplayMode("reconnecting");
    }, reconnectHoldMs);
    return () => window.clearTimeout(timer);
  }, [rawMode, reconnectHoldMs]);

  return {
    mode: displayMode,
    streamsEnabled: displayMode !== "off",
    bybitConnected: displayMode === "connected",
  };
}
