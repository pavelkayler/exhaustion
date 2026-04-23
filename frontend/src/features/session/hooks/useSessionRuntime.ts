import { useCallback, useEffect, useState } from "react";
import type { StatusResponse } from "../../../shared/types/domain";
import { fetchStatus, pauseSession, resumeSession, startSession, stopSession, type StartSessionPayload } from "../api/sessionApi";
import { useInterval } from "../../../shared/hooks/useInterval";
import { useWsFeedLite } from "../../ws/hooks/useWsFeed";

type UseSessionRuntimeOptions = {
  enablePolling?: boolean;
  pollMs?: number;
};

function isSameStatus(a: StatusResponse, b: StatusResponse): boolean {
  return a.sessionState === b.sessionState
    && a.sessionId === b.sessionId
    && a.eventsFile === b.eventsFile
    && (a.runningSinceMs ?? null) === (b.runningSinceMs ?? null)
    && (a.runtimeMessage ?? null) === (b.runtimeMessage ?? null)
    && (a.runningBotId ?? null) === (b.runningBotId ?? null)
    && (a.runningBotName ?? null) === (b.runningBotName ?? null);
}

export function useSessionRuntime(options?: UseSessionRuntimeOptions) {
  const enablePolling = options?.enablePolling ?? true;
  const pollMs = Math.max(1_000, Math.floor(Number(options?.pollMs ?? 5_000) || 5_000));
  const wsRuntime = useWsFeedLite();
  const [status, setStatus] = useState<StatusResponse>({
    sessionState: "STOPPED",
    sessionId: null,
    eventsFile: null,
    runningSinceMs: null,
    runtimeMessage: null,
    runningBotId: null,
    runningBotName: null,
  });

  const [busy, setBusy] = useState<"none" | "start" | "stop" | "pause" | "resume">("none");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    if (!force && wsRuntime.conn === "CONNECTED") return;
    if (!force && typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const st = await fetchStatus();
      setStatus((prev) => (isSameStatus(prev, st) ? prev : st));
    } catch {
      return;
    }
  }, [wsRuntime.conn]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    setStatus((prev) => {
      const next: StatusResponse = {
        ...prev,
        sessionState: wsRuntime.wsSessionState,
        sessionId: wsRuntime.wsSessionId,
        runningSinceMs: wsRuntime.wsRunningSinceMs,
      };
      return isSameStatus(prev, next) ? prev : next;
    });
  }, [wsRuntime.wsRunningSinceMs, wsRuntime.wsSessionId, wsRuntime.wsSessionState]);

  useInterval(() => void refresh(), enablePolling && wsRuntime.conn !== "CONNECTED" ? pollMs : null);

  const start = useCallback(async (payload?: StartSessionPayload) => {
    setError(null);
    setBusy("start");
    try {
      setStatus(await startSession(payload));
    } catch (e) {
      setError(String((e as { message?: unknown } | null)?.message ?? e));
    } finally {
      setBusy("none");
    }
  }, []);

  const stop = useCallback(async () => {
    setError(null);
    setBusy("stop");
    try {
      setStatus(await stopSession());
    } catch (e) {
      setError(String((e as { message?: unknown } | null)?.message ?? e));
    } finally {
      setBusy("none");
    }
  }, []);

  const pause = useCallback(async () => {
    setError(null);
    setBusy("pause");
    try {
      setStatus(await pauseSession());
    } catch (e) {
      setError(String((e as { message?: unknown } | null)?.message ?? e));
    } finally {
      setBusy("none");
    }
  }, []);

  const resume = useCallback(async () => {
    setError(null);
    setBusy("resume");
    try {
      setStatus(await resumeSession());
    } catch (e) {
      setError(String((e as { message?: unknown } | null)?.message ?? e));
    } finally {
      setBusy("none");
    }
  }, []);

  const canStart = status.sessionState === "STOPPED" && busy === "none";
  const canStop = (status.sessionState === "RUNNING" || status.sessionState === "PAUSED" || status.sessionState === "RESUMING") && busy === "none";
  const canPause = status.sessionState === "RUNNING" && busy === "none";
  const canResume = status.sessionState === "PAUSED" && busy === "none";

  return { status, busy, error, start, stop, pause, resume, refresh, canStart, canStop, canPause, canResume };
}
