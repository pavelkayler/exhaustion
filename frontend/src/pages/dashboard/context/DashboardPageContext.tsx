import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { useWsFeed } from "../../../features/ws/hooks/useWsFeed";
import { useSessionRuntime } from "../../../features/session/hooks/useSessionRuntime";
import { usePersistentState } from "../../../shared/hooks/usePersistentState";
import { useRuntimeConfig } from "../../../features/config/hooks/useRuntimeConfig";
import type { SymbolRow } from "../../../shared/types/domain";

type DashboardPageContextValue = {
  conn: ReturnType<typeof useWsFeed>["conn"];
  lastServerTime: ReturnType<typeof useWsFeed>["lastServerTime"];
  wsUrl: ReturnType<typeof useWsFeed>["wsUrl"];
  streams: ReturnType<typeof useWsFeed>["streams"];
  rows: ReturnType<typeof useWsFeed>["rows"];
  availableWsSymbols: ReturnType<typeof useWsFeed>["availableWsSymbols"];
  availableWsRows: ReturnType<typeof useWsFeed>["availableWsRows"];
  events: ReturnType<typeof useWsFeed>["events"];
  botStats: ReturnType<typeof useWsFeed>["botStats"];
  requestEventsTail: ReturnType<typeof useWsFeed>["requestEventsTail"];
  requestRowsRefresh: ReturnType<typeof useWsFeed>["requestRowsRefresh"];
  status: ReturnType<typeof useSessionRuntime>["status"];
  busy: ReturnType<typeof useSessionRuntime>["busy"];
  error: ReturnType<typeof useSessionRuntime>["error"];
  start: ReturnType<typeof useSessionRuntime>["start"];
  stop: ReturnType<typeof useSessionRuntime>["stop"];
  pause: ReturnType<typeof useSessionRuntime>["pause"];
  resume: ReturnType<typeof useSessionRuntime>["resume"];
  canStart: ReturnType<typeof useSessionRuntime>["canStart"];
  canStop: ReturnType<typeof useSessionRuntime>["canStop"];
  canPause: ReturnType<typeof useSessionRuntime>["canPause"];
  canResume: ReturnType<typeof useSessionRuntime>["canResume"];
  runtimeConfig: ReturnType<typeof useRuntimeConfig>["config"];
  activeOnly: boolean;
  setActiveOnly: (value: boolean) => void;
  showLastFive: boolean;
  setShowLastFive: (value: boolean) => void;
  displayedRows: SymbolRow[];
  uptimeText: string | null;
  nextCandle: string;
};

const DashboardPageContext = createContext<DashboardPageContextValue | null>(null);

function parseSessionStartTs(sessionId: string | null): number | null {
  if (!sessionId) return null;
  const match = sessionId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (match) {
    const [, date, hh, mm, ss, ms] = match;
    const parsed = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(sessionId);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  if (hh > 0) {
    return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  }
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

export function DashboardPageProvider({ children }: PropsWithChildren) {
  const {
    conn,
    rows,
    availableWsSymbols,
    availableWsRows,
    lastServerTime,
    wsUrl,
    wsSessionState,
    wsSessionId,
    wsRunningSinceMs,
    streams,
    events,
    botStats,
    requestEventsTail,
    requestRowsRefresh,
  } = useWsFeed();
  const { status, busy, error, start, stop, pause, resume, canStart, canStop, canPause, canResume } = useSessionRuntime({
    pollMs: conn === "CONNECTED" ? 15_000 : 5_000,
  });
  const { config: runtimeConfig } = useRuntimeConfig();

  const [activeOnly, setActiveOnly] = usePersistentState<boolean>("dashboard.activeOnly", true);
  const [showLastFive, setShowLastFive] = usePersistentState<boolean>("dashboard.showLastFive", false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [rowsSnapshot, setRowsSnapshot] = useState<typeof rows>([]);
  const latestRowsRef = useRef<typeof rows>(rows);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    latestRowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    setRowsSnapshot(latestRowsRef.current);
    const id = window.setInterval(() => {
      setRowsSnapshot(latestRowsRef.current);
    }, 5_000);
    return () => window.clearInterval(id);
  }, []);

  const displayedRows = useMemo(() => {
    const activeRows = rowsSnapshot.filter((row: SymbolRow) => {
      const paperActive = row.paperStatus === "ENTRY_PENDING" || row.paperStatus === "OPEN";
      const hasSignal = row.signal === "LONG" || row.signal === "SHORT";
      return paperActive || hasSignal;
    });
    if (showLastFive) {
      return [...activeRows]
        .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
        .slice(0, 5);
    }
    if (activeOnly) return activeRows;
    return rowsSnapshot;
  }, [rowsSnapshot, activeOnly, showLastFive]);

  const runningSinceMs = wsSessionState === "RUNNING" ? wsRunningSinceMs : status.runningSinceMs ?? null;
  const runningSessionId = wsSessionState === "RUNNING" ? wsSessionId : status.sessionId;
  const sessionStartTs = useMemo(() => runningSinceMs ?? parseSessionStartTs(runningSessionId), [runningSessionId, runningSinceMs]);
  const uptimeText = (wsSessionState === "RUNNING" || status.sessionState === "RUNNING") && sessionStartTs != null ? formatElapsed(nowMs - sessionStartTs) : null;

  const tfMs = 60_000;
  const remMs = tfMs - (nowMs % tfMs);
  const remMin = Math.floor(remMs / 60_000);
  const remSec = Math.floor((remMs % 60_000) / 1000);
  const nextCandle = `${remMin}:${remSec.toString().padStart(2, "0")}`;

  const value: DashboardPageContextValue = {
    conn,
    lastServerTime,
    wsUrl,
    streams,
    rows,
    availableWsSymbols,
    availableWsRows,
    events,
    botStats,
    requestEventsTail,
    requestRowsRefresh,
    status,
    busy,
    error,
    start,
    stop,
    pause,
    resume,
    canStart,
    canStop,
    canPause,
    canResume,
    runtimeConfig,
    activeOnly,
    setActiveOnly,
    showLastFive,
    setShowLastFive,
    displayedRows,
    uptimeText,
    nextCandle,
  };

  return <DashboardPageContext.Provider value={value}>{children}</DashboardPageContext.Provider>;
}

export function useDashboardPageContext() {
  const value = useContext(DashboardPageContext);
  if (!value) {
    throw new Error("useDashboardPageContext must be used inside DashboardPageProvider");
  }
  return value;
}
