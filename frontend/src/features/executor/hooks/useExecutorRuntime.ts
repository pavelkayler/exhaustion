import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchExecutorStatus,
  startExecutor,
  stopExecutor,
  updateExecutorSettings,
} from "../api/executorApi";
import { useInterval } from "../../../shared/hooks/useInterval";
import type {
  ExecutorSettings,
  ExecutorStatusResponse,
} from "../../../shared/types/domain";
import { DEFAULT_EXECUTOR_LOCAL_SETTINGS } from "../../../pages/shortExecution/model";

const EXECUTOR_STATUS_UPDATED_EVENT = "executor-status-updated";

const DEFAULT_STATUS: ExecutorStatusResponse = {
  settings: DEFAULT_EXECUTOR_LOCAL_SETTINGS,
  activeSettings: null,
  desiredRunning: false,
  status: "stopped",
  error: null,
  updatedAt: null,
};

function mergeSettings(
  base: ExecutorSettings,
  patch: Partial<ExecutorSettings>,
): ExecutorSettings {
  return {
    ...base,
    ...patch,
  };
}

export function useExecutorRuntime(options?: { pollMs?: number; enablePolling?: boolean }) {
  const pollMs = Math.max(1_000, Math.floor(Number(options?.pollMs ?? 5_000) || 5_000));
  const enablePolling = options?.enablePolling ?? true;

  const [state, setState] = useState<ExecutorStatusResponse>(DEFAULT_STATUS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"none" | "start" | "stop" | "save">("none");
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const emitUpdate = useCallback((next: ExecutorStatusResponse) => {
    window.dispatchEvent(
      new CustomEvent<ExecutorStatusResponse>(EXECUTOR_STATUS_UPDATED_EVENT, {
        detail: next,
      }),
    );
  }, []);

  const applyServerState = useCallback(
    (next: ExecutorStatusResponse) => {
      setState(next);
      emitUpdate(next);
    },
    [emitUpdate],
  );

  const reload = useCallback(async () => {
    try {
      const next = await fetchExecutorStatus();
      setError(null);
      applyServerState(next);
    } catch (nextError) {
      setError(String((nextError as Error)?.message ?? nextError));
    } finally {
      setLoading(false);
    }
  }, [applyServerState]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    function onExecutorStatusUpdated(event: Event) {
      const detail = (event as CustomEvent<ExecutorStatusResponse>).detail;
      if (!detail) return;
      setState(detail);
    }
    window.addEventListener(EXECUTOR_STATUS_UPDATED_EVENT, onExecutorStatusUpdated as EventListener);
    return () => {
      window.removeEventListener(EXECUTOR_STATUS_UPDATED_EVENT, onExecutorStatusUpdated as EventListener);
    };
  }, []);

  useInterval(() => {
    void reload();
  }, enablePolling ? pollMs : null);

  const queueSettingsUpdate = useCallback(
    async (patch: Partial<ExecutorSettings>) => {
      const optimistic: ExecutorStatusResponse = {
        ...state,
        settings: mergeSettings(state.settings, patch),
      };
      setState(optimistic);
      setBusy("save");
      setError(null);

      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const next = await updateExecutorSettings(patch);
          applyServerState(next);
        })
        .catch((nextError) => {
          setError(String((nextError as Error)?.message ?? nextError));
        })
        .finally(() => {
          setBusy((current) => (current === "save" ? "none" : current));
        });

      await saveQueueRef.current;
    },
    [applyServerState, state],
  );

  const start = useCallback(async () => {
    setBusy("start");
    setError(null);
    try {
      const next = await startExecutor();
      applyServerState(next);
    } catch (nextError) {
      setError(String((nextError as Error)?.message ?? nextError));
    } finally {
      setBusy("none");
    }
  }, [applyServerState]);

  const stop = useCallback(async () => {
    setBusy("stop");
    setError(null);
    try {
      const next = await stopExecutor();
      applyServerState(next);
    } catch (nextError) {
      setError(String((nextError as Error)?.message ?? nextError));
    } finally {
      setBusy("none");
    }
  }, [applyServerState]);

  const activeMode = useMemo(() => {
    return state.activeSettings?.mode ?? state.settings.mode;
  }, [state.activeSettings, state.settings.mode]);

  return {
    state,
    settings: state.settings,
    activeSettings: state.activeSettings,
    activeMode,
    status: state.status,
    desiredRunning: state.desiredRunning,
    error: error ?? state.error,
    busy,
    loading,
    reload,
    updateSettings: queueSettingsUpdate,
    start,
    stop,
  };
}

export function useExecutorStatusLite(options?: { pollMs?: number }) {
  const pollMs = Math.max(1_000, Math.floor(Number(options?.pollMs ?? 5_000) || 5_000));
  const [state, setState] = useState<ExecutorStatusResponse>(DEFAULT_STATUS);

  const reload = useCallback(async () => {
    try {
      const next = await fetchExecutorStatus();
      setState(next);
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    function onExecutorStatusUpdated(event: Event) {
      const detail = (event as CustomEvent<ExecutorStatusResponse>).detail;
      if (!detail) return;
      setState(detail);
    }
    window.addEventListener(EXECUTOR_STATUS_UPDATED_EVENT, onExecutorStatusUpdated as EventListener);
    return () => {
      window.removeEventListener(EXECUTOR_STATUS_UPDATED_EVENT, onExecutorStatusUpdated as EventListener);
    };
  }, []);

  useInterval(() => {
    void reload();
  }, pollMs);

  return {
    status: state.status,
    desiredRunning: state.desiredRunning,
    error: state.error,
  };
}
