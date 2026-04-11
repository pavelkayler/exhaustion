import type { BybitDemoRestClient } from "../../bybit/BybitDemoRestClient.js";
import type { EventLogger } from "../../logging/EventLogger.js";

type PollDemoExecutionsDeps = {
  token: number;
  rest: BybitDemoRestClient;
  logger: EventLogger;
  eventType: (suffix: string) => string;
  isRunningLifecycle: (token?: number) => boolean;
  parseNumber: (value: unknown) => number;
  sessionStartedAtMs: number;
  lastExecTimeMs: number | null;
  setLastExecTimeMs: (value: number | null) => void;
  execSeenIds: Set<string>;
  trackExecSeen: (execId: string) => void;
  addDemoFeesUsdt: (value: number) => void;
};

export async function pollDemoExecutions(deps: PollDemoExecutionsDeps): Promise<void> {
  const nowMs = Date.now();
  const startFloor = deps.sessionStartedAtMs > 0 ? Math.max(0, deps.sessionStartedAtMs - 2000) : nowMs - (5 * 60 * 1000);
  const startTime = deps.lastExecTimeMs != null ? Math.max(startFloor, deps.lastExecTimeMs - 2000) : startFloor;
  const resp = await deps.rest.getExecutionsLinear({ startTime, limit: 100 });
  if (!deps.isRunningLifecycle(deps.token)) return;
  const list = Array.isArray(resp.list) ? resp.list : [];
  let nextLastExecTimeMs = deps.lastExecTimeMs;
  deps.logger.log({
    ts: nowMs,
    type: deps.eventType("EXECUTIONS_OK"),
    payload: { startTime, fetched: list.length },
  });
  for (const exec of list) {
    const execId = String(exec.execId ?? "");
    if (!execId || deps.execSeenIds.has(execId)) continue;
    deps.trackExecSeen(execId);

    const execFee = deps.parseNumber(exec.execFee);
    deps.addDemoFeesUsdt(execFee);
    const execTimeMs = Number(exec.execTime ?? 0);
    const ts = Number.isFinite(execTimeMs) && execTimeMs > 0 ? execTimeMs : nowMs;
    if (Number.isFinite(execTimeMs) && execTimeMs > 0) {
      nextLastExecTimeMs = nextLastExecTimeMs == null ? execTimeMs : Math.max(nextLastExecTimeMs, execTimeMs);
      deps.setLastExecTimeMs(nextLastExecTimeMs);
    }
    deps.logger.log({
      ts,
      type: deps.eventType("FILL"),
      symbol: String(exec.symbol ?? ""),
      payload: {
        execId,
        orderId: String(exec.orderId ?? ""),
        side: String(exec.side ?? "").toUpperCase(),
        execPrice: deps.parseNumber(exec.orderPrice),
        execQty: deps.parseNumber(exec.execQty),
        execFee,
        closedPnl: deps.parseNumber(exec.closedPnl),
        realizedPnl: 0,
        execType: String(exec.execType ?? ""),
      },
    });
  }
}
