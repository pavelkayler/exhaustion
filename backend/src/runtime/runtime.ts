import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { buildRuntimeBotStats, resolveRuntimePaperView } from "./brokerViews.js";
import { configStore } from "./configStore.js";
import { submitRuntimeManualTestOrder } from "./manualOrders.js";
import { dispatchRuntimeTick } from "./signalDispatch.js";
import type { ManualTestOrderResult, RuntimeBotStats } from "./types.js";
import { EventLogger, type LogEvent } from "../logging/EventLogger.js";
import { getBotDefinition } from "../bots/registry.js";
import { PaperBroker, type PaperView } from "../paper/PaperBroker.js";
import { PaperBrokerPool } from "../paper/PaperBrokerPool.js";
import { DemoBroker } from "../demo/DemoBroker.js";
import { RealBroker } from "../real/RealBroker.js";
import {
  computePaperSummaryFromEvents,
  getSummaryFilePathFromEventsFile,
  persistSummaryFile
} from "../paper/summary.js";

export type RuntimeSessionState = "STOPPED" | "RUNNING" | "STOPPING" | "PAUSING" | "PAUSED" | "RESUMING";

type Status = {
  sessionState: RuntimeSessionState;
  sessionId: string | null;
  eventsFile: string | null;
  summaryFile: string | null;
  runningSinceMs: number | null;
  runtimeMessage: string | null;
  runningBotId: string | null;
  runningBotName: string | null;
};

type StartOptions = {
  waitForReady?: (ctx: { runId: string; signal: AbortSignal }) => Promise<void>;
};

type RunContext = {
  runId: string;
  abortController: AbortController;
  startedAt: number;
  stopRequestedAt: number | null;
  botId: string;
  botName: string;
};

const STARTUP_OPERATION_TIMEOUT_MS = 5_000;
const STOP_OPERATION_TIMEOUT_MS = 5_000;
const STOP_OVERALL_TIMEOUT_MS = 15_000;

type ClosedTrade = {
  symbol: string;
  side: "LONG" | "SHORT";
  realizedPnl: number;
  feesPaid: number;
  fundingAccrued: number;
  closedAt: number;
  closeType: "TP" | "SL" | "FORCE";
  minRoiPct: number | null;
  maxRoiPct: number | null;
};

type TradeStatsBySymbolRow = {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  fees: number;
  funding: number;
  lastCloseTs: number | null;
  longTrades: number;
  longWins: number;
  shortTrades: number;
  shortWins: number;
};

type TradeExcursionsRow = {
  symbol: string;
  tpTrades: number;
  tpWorstMinRoiPct: number | null;
  slTrades: number;
  slBestMaxRoiPct: number | null;
};

function toMskDayKey(ts: number): string {
  const shifted = ts + 3 * 60 * 60 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function newSessionId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class Runtime extends EventEmitter {
  private sessionState: RuntimeSessionState = "STOPPED";
  private sessionId: string | null = null;

  private logger: EventLogger | null = null;
  private paper: PaperBrokerPool | PaperBroker | null = null;
  private demo: DemoBroker | null = null;
  private real: RealBroker | null = null;

  private summaryFilePath: string | null = null;
  private demoStartedAtMs: number | null = null;
  private runningSinceMs: number | null = null;

  private getMarkPrice: ((symbol: string) => number | null) | null = null;
  private closedTrades: ClosedTrade[] = [];
  private runContext: RunContext | null = null;
  private stopPromise: Promise<Status> | null = null;
  private runtimeMessage: string | null = null;
  private emergencyStopInFlight = false;
  private emergencyStopActive = false;
  private emergencyStopReason: string | null = null;
  private riskDayKey: string | null = null;
  private riskEntriesPerDay = 0;
  private riskNetRealizedPerDay = 0;
  private riskNetRealizedSession = 0;
  private riskConsecutiveErrors = 0;
  private riskSkipEntryLogged = new Set<string>();
  private recentEntryAttemptsBySymbolSide = new Map<string, number[]>();

  private transitionState(nextState: RuntimeSessionState) {
    const fromState = this.sessionState;
    this.sessionState = nextState;
    const runId = this.runContext?.runId ?? this.sessionId;
    this.logger?.log({
      ts: Date.now(),
      type: "SESSION_STATE",
      payload: { state: nextState, fromState, runId, sessionId: this.sessionId }
    });
  }

  private logSessionStopRequested(source: string, payload?: Record<string, unknown>) {
    this.logger?.log({
      ts: Date.now(),
      type: "SESSION_STOP_REQUESTED",
      payload: {
        source,
        sessionId: this.sessionId,
        runId: this.runContext?.runId ?? this.sessionId,
        state: this.sessionState,
        ...(payload ?? {}),
      },
    });
  }

  private stopTransientBrokers() {
    this.paper = null;
    this.demo?.stop();
    this.real?.stop();
    this.demo = null;
    this.real = null;
  }

  private async closeLoggerSafely(): Promise<void> {
    try {
      await this.logger?.close();
    } catch {
      // ignore
    }
  }

  private async withAbortAndTimeout<T>(promise: Promise<T>, args: { signal: AbortSignal; timeoutMs: number; label: string }): Promise<T> {
    const { signal, timeoutMs, label } = args;
    if (signal.aborted) throw new Error(`aborted:${label}`);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout:${label}`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new Error(`aborted:${label}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then((value) => {
        cleanup();
        resolve(value);
      }).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  private attachLogger(sessionId: string) {
    this.logger = new EventLogger(sessionId, (ev: LogEvent) => {
      const eventType = String(ev?.type ?? "");
      if (
        eventType === "POSITION_CLOSE_TP"
        || eventType === "POSITION_CLOSE_SL"
        || eventType === "POSITION_FORCE_CLOSE"
        || eventType === "DEMO_EXECUTION"
      ) {
        const payload = (ev?.payload ?? {}) as any;
        const side = String(payload.side ?? "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
        const closedAtRaw = Number(payload.closedAt ?? payload.closedTs ?? ev.ts ?? Date.now());
        const closedAt = Number.isFinite(closedAtRaw) ? closedAtRaw : Date.now();
        const minRoi = Number(payload.minRoiPct);
        const maxRoi = Number(payload.maxRoiPct);
        const rawCloseType = String(payload.closeType ?? "");
        const closeType = eventType === "POSITION_CLOSE_TP"
          ? "TP"
          : eventType === "POSITION_CLOSE_SL"
            ? "SL"
            : rawCloseType === "TP" || rawCloseType === "SL"
              ? rawCloseType
              : "FORCE";

        this.closedTrades.push({
          symbol: String(ev.symbol ?? "").trim(),
          side,
          realizedPnl: Number(payload.realizedPnl ?? 0) || 0,
          feesPaid: Number(payload.feesPaid ?? 0) || 0,
          fundingAccrued: Number(payload.fundingAccrued ?? 0) || 0,
          closedAt,
          closeType,
          minRoiPct: Number.isFinite(minRoi) ? minRoi : null,
          maxRoiPct: Number.isFinite(maxRoi) ? maxRoi : null,
        });
      }
      this.handleRuntimeEvent(ev);
      this.emit("event", ev);
    });
  }

  private ensureManualBroker(executionMode: "paper" | "demo" | "real" | "empty") {
    const cfg = configStore.get();
    if (!this.logger) {
      this.attachLogger(`manual-${newSessionId()}`);
    }
    if (executionMode === "demo") {
      if (this.real) {
        this.real.stop();
        this.real = null;
      }
      this.paper = null;
      if (!this.demo) {
        this.demo = new DemoBroker(cfg.paper, this.logger!, this.sessionId ?? "manual-demo", this.getMarkPrice ?? undefined);
      } else {
        this.demo.applyConfigForNextTrades(cfg.paper);
      }
      this.demo.start();
      return;
    }
    if (executionMode === "real") {
      if (this.demo) {
        this.demo.stop();
        this.demo = null;
      }
      this.paper = null;
      if (!this.real) {
        this.real = new RealBroker(cfg.paper, this.logger!, this.sessionId ?? "manual-real", this.getMarkPrice ?? undefined);
      } else {
        this.real.applyConfigForNextTrades(cfg.paper);
      }
      this.real.start();
      return;
    }
    if (executionMode === "paper") {
      this.demo?.stop();
      this.real?.stop();
      this.demo = null;
      this.real = null;
      if (!this.paper) {
        this.paper = new PaperBrokerPool(cfg.paper, this.logger!, this.sessionId ?? "manual-paper");
      } else {
        this.paper.applyConfigForNextTrades(cfg.paper);
      }
    }
  }

  private resetRiskState(nowMs: number) {
    this.riskDayKey = toMskDayKey(nowMs);
    this.riskEntriesPerDay = 0;
    this.riskNetRealizedPerDay = 0;
    this.riskNetRealizedSession = 0;
    this.riskConsecutiveErrors = 0;
    this.riskSkipEntryLogged = new Set();
    this.recentEntryAttemptsBySymbolSide = new Map();
    this.emergencyStopInFlight = false;
    this.emergencyStopActive = false;
    this.emergencyStopReason = null;
  }

  private syncRiskDay(nowMs: number) {
    const nextDay = toMskDayKey(nowMs);
    if (this.riskDayKey === nextDay) return;
    this.riskDayKey = nextDay;
    this.riskEntriesPerDay = 0;
    this.riskNetRealizedPerDay = 0;
    this.riskSkipEntryLogged.clear();
    this.recentEntryAttemptsBySymbolSide.clear();
  }

  private getRiskLimits() {
    return configStore.get().riskLimits;
  }

  private checkLossThresholdBreach(): string | null {
    const limits = this.getRiskLimits();
    const dayLimit = limits.maxLossPerDayUsdt;
    if (dayLimit != null && Number.isFinite(dayLimit) && dayLimit > 0 && this.riskNetRealizedPerDay <= -dayLimit) {
      return `maxLossPerDayUsdt reached (${this.riskNetRealizedPerDay.toFixed(4)} <= -${dayLimit})`;
    }
    const sessionLimit = limits.maxLossPerSessionUsdt;
    if (sessionLimit != null && Number.isFinite(sessionLimit) && sessionLimit > 0 && this.riskNetRealizedSession <= -sessionLimit) {
      return `maxLossPerSessionUsdt reached (${this.riskNetRealizedSession.toFixed(4)} <= -${sessionLimit})`;
    }
    return null;
  }

  private getActiveTradesCount(symbol: string, side?: "LONG" | "SHORT"): number {
    const paperCount = this.paper && typeof (this.paper as any).getActiveTradesCount === "function"
      ? Number((this.paper as any).getActiveTradesCount(symbol, side) ?? 0)
      : 0;
    const demoCount = this.demo && typeof (this.demo as any).getActiveTradesCount === "function"
      ? Number((this.demo as any).getActiveTradesCount(symbol, side) ?? 0)
      : 0;
    const realCount = this.real && typeof (this.real as any).getActiveTradesCount === "function"
      ? Number((this.real as any).getActiveTradesCount(symbol, side) ?? 0)
      : 0;
    return Math.max(0, Math.floor(Math.max(paperCount, demoCount, realCount, 0)));
  }

  private pruneRecentEntryAttempts(nowMs: number, windowMs: number) {
    const cutoff = nowMs - windowMs;
    for (const [key, timestamps] of this.recentEntryAttemptsBySymbolSide.entries()) {
      const next = timestamps.filter((ts) => ts > cutoff);
      if (next.length > 0) this.recentEntryAttemptsBySymbolSide.set(key, next);
      else this.recentEntryAttemptsBySymbolSide.delete(key);
    }
  }

  private maybeTriggerEmergencyStop(reason: string, nowMs: number) {
    if (this.emergencyStopActive) return;
    if (this.emergencyStopInFlight) return;
    this.emergencyStopInFlight = true;
    this.emergencyStopActive = true;
    this.emergencyStopReason = reason;
    this.runtimeMessage = `Emergency stop: ${reason}`;
    this.logger?.log({
      ts: nowMs,
      type: "EMERGENCY_STOP",
      payload: {
        reason,
        entriesPerDay: this.riskEntriesPerDay,
        netRealizedPerDay: this.riskNetRealizedPerDay,
        netRealizedSession: this.riskNetRealizedSession,
        consecutiveErrors: this.riskConsecutiveErrors,
      },
    });

    if (this.sessionState === "RUNNING" || this.sessionState === "RESUMING") {
      void this.stop("emergency_stop").finally(() => {
        this.emergencyStopInFlight = false;
      });
      return;
    }

    this.emergencyStopInFlight = false;
  }

  private handleRuntimeEvent(ev: LogEvent) {
    const nowMs = Number.isFinite(Number(ev?.ts)) ? Number(ev.ts) : Date.now();
    this.syncRiskDay(nowMs);

    const type = String(ev?.type ?? "");
    if (type === "DEMO_ORDER_PLACE" || type === "REAL_ORDER_PLACE") {
      const payload = (ev?.payload ?? {}) as any;
      const sideValue = String(payload.side ?? "").toUpperCase();
      const side = sideValue === "SELL" ? "SHORT" : sideValue === "BUY" ? "LONG" : null;
      const symbol = String(ev?.symbol ?? "").trim().toUpperCase();
      if (side && symbol) this.recordRecentEntryAttempt(symbol, side, nowMs);
      return;
    }

    if (type === "POSITION_OPEN" || type === "DEMO_POSITION_OPEN") {
      this.riskEntriesPerDay += 1;
      this.riskConsecutiveErrors = 0;
      return;
    }

    if (type === "DEMO_ORDER_ERROR") {
      const payload = (ev?.payload ?? {}) as any;
      const reason = String(payload.reason ?? "");
      const retCode = Number(payload.retCode);
      if (reason === "timestamp_window_transient" || retCode === 10002 || retCode === -1) {
        return;
      }
      this.riskConsecutiveErrors += 1;
      const limit = this.getRiskLimits().maxConsecutiveErrors;
      if (this.riskConsecutiveErrors >= limit) {
        this.maybeTriggerEmergencyStop(`maxConsecutiveErrors reached (${this.riskConsecutiveErrors}/${limit})`, nowMs);
      }
      return;
    }

    const isCloseEvent = type === "POSITION_CLOSE_TP" || type === "POSITION_CLOSE_SL" || type === "POSITION_FORCE_CLOSE" || type === "DEMO_EXECUTION";
    if (!isCloseEvent) return;

    const payload = (ev?.payload ?? {}) as any;
    const realizedPnl = Number(payload.realizedPnl ?? payload.closedPnl ?? 0);
    if (!Number.isFinite(realizedPnl)) return;

    this.riskNetRealizedSession += realizedPnl;
    this.riskNetRealizedPerDay += realizedPnl;

    const breach = this.checkLossThresholdBreach();
    if (breach) this.maybeTriggerEmergencyStop(breach, nowMs);
  }

  private evaluateEntryAllowance(symbol: string, nowMs: number, maxTradesPerSymbol = 1, side?: "LONG" | "SHORT"): { allowed: boolean; reason?: string } {
    this.syncRiskDay(nowMs);

    if (this.emergencyStopActive) {
      if (this.runtimeMessage == null && this.emergencyStopReason) {
        this.runtimeMessage = `Emergency stop: ${this.emergencyStopReason}`;
      }
      return { allowed: false, reason: "emergency_stop_active" };
    }

    const lossBreach = this.checkLossThresholdBreach();
    if (lossBreach) {
      this.maybeTriggerEmergencyStop(lossBreach, nowMs);
      return { allowed: false, reason: "risk_loss_limit_reached" };
    }

    const limits = this.getRiskLimits();
    if (this.riskConsecutiveErrors >= limits.maxConsecutiveErrors) {
      this.maybeTriggerEmergencyStop(`maxConsecutiveErrors reached (${this.riskConsecutiveErrors}/${limits.maxConsecutiveErrors})`, nowMs);
      return { allowed: false, reason: "risk_max_consecutive_errors" };
    }

    const dayLimit = limits.maxTradesPerDay;
    if (this.riskEntriesPerDay >= dayLimit) {
      const dayKey = this.riskDayKey ?? toMskDayKey(nowMs);
      const dedupeKey = `${dayKey}:${symbol}`;
      if (!this.riskSkipEntryLogged.has(dedupeKey)) {
        this.riskSkipEntryLogged.add(dedupeKey);
        this.logger?.log({
          ts: nowMs,
          type: "ORDER_SKIPPED",
          symbol,
          payload: {
            reason: "risk_max_trades_per_day",
            maxTradesPerDay: dayLimit,
            entriesPerDay: this.riskEntriesPerDay,
            day: dayKey,
          },
        });
      }
      return { allowed: false, reason: "risk_max_trades_per_day" };
    }

    const perSymbolLimit = Math.max(1, Math.floor(Number(maxTradesPerSymbol) || 1));
    const activeTrades = this.getActiveTradesCount(symbol, side);
    if (activeTrades >= perSymbolLimit) {
      const dedupeKey = `symbol-limit:${symbol}:${perSymbolLimit}`;
      if (!this.riskSkipEntryLogged.has(dedupeKey)) {
        this.riskSkipEntryLogged.add(dedupeKey);
        this.logger?.log({
          ts: nowMs,
          type: "ORDER_SKIPPED",
          symbol,
          payload: {
            reason: "risk_trades_per_symbol",
            maxTradesPerSymbol: perSymbolLimit,
            activeTrades,
          },
        });
      }
      return { allowed: false, reason: "risk_trades_per_symbol" };
    }

    const burstWindowSec = Math.max(1, Math.floor(Number(limits.burstWindowSec) || 1));
    const maxBurstEntriesPerSide = Math.max(1, Math.floor(Number(limits.maxBurstEntriesPerSide) || 1));
    if (side) {
      const windowMs = burstWindowSec * 1000;
      this.pruneRecentEntryAttempts(nowMs, windowMs);
      const burstKey = `${side}:${symbol}`;
      const recentSideEntries = this.recentEntryAttemptsBySymbolSide.get(burstKey) ?? [];
      if (recentSideEntries.length >= maxBurstEntriesPerSide) {
        const burstBucket = Math.floor(nowMs / windowMs);
        const dedupeKey = `burst:${side}:${symbol}:${burstBucket}`;
        if (!this.riskSkipEntryLogged.has(dedupeKey)) {
          this.riskSkipEntryLogged.add(dedupeKey);
          this.logger?.log({
            ts: nowMs,
            type: "ORDER_SKIPPED",
            symbol,
            payload: {
              reason: "risk_burst_per_side",
              side,
              burstWindowSec,
              maxBurstEntriesPerSide,
              recentEntries: recentSideEntries.length,
            },
          });
        }
        return { allowed: false, reason: "risk_burst_per_side" };
      }
    }

    return { allowed: true };
  }

  private recordRecentEntryAttempt(symbol: string, side: "LONG" | "SHORT", nowMs: number) {
    const limits = this.getRiskLimits();
    const burstWindowSec = Math.max(1, Math.floor(Number(limits.burstWindowSec) || 1));
    const windowMs = burstWindowSec * 1000;
    this.pruneRecentEntryAttempts(nowMs, windowMs);
    const burstKey = `${side}:${symbol}`;
    const recentSideEntries = this.recentEntryAttemptsBySymbolSide.get(burstKey) ?? [];
    recentSideEntries.push(nowMs);
    this.recentEntryAttemptsBySymbolSide.set(burstKey, recentSideEntries);
  }

  private shouldAllowEntry(symbol: string, nowMs: number, maxTradesPerSymbol = 1): boolean {
    return this.evaluateEntryAllowance(symbol, nowMs, maxTradesPerSymbol).allowed;
  }

  attachMarkPriceProvider(fn: (symbol: string) => number | null) {
    this.getMarkPrice = fn;
  }

  logEvent(event: LogEvent): boolean {
    const normalized: LogEvent = {
      ts: Number.isFinite(Number(event?.ts)) ? Number(event.ts) : Date.now(),
      type: String(event?.type ?? "RUNTIME_EVENT"),
      ...(event?.symbol ? { symbol: String(event.symbol) } : {}),
      ...(typeof event?.payload !== "undefined" ? { payload: event.payload } : {}),
    };
    if (!this.logger) {
      this.emit("event", normalized);
      return true;
    }
    this.logger.log(normalized);
    return true;
  }

  applyConfigForNextTrades(patch: Partial<{
    enabled: boolean;
    directionMode: "both" | "long" | "short";
    marginUSDT: number;
    leverage: number;
    entryOffsetPct: number;
    entryTimeoutSec: number;
    tpRoiPct: number;
    slRoiPct: number;
    rearmDelayMs: number;
    maxDailyLossUSDT: number;
  }>): { applied: boolean; reason?: string } {
    if (this.sessionState !== "RUNNING" && this.sessionState !== "PAUSED" && this.sessionState !== "RESUMING") {
      return { applied: false, reason: "session_not_active" };
    }
    const keys = Object.keys(patch ?? {});
    if (!keys.length) return { applied: false, reason: "empty_patch" };
    if (this.paper) this.paper.applyConfigForNextTrades(patch);
    if (this.demo) this.demo.applyConfigForNextTrades(patch);
    if (this.real) this.real.applyConfigForNextTrades(patch);
    this.logger?.log({
      ts: Date.now(),
      type: "CONFIG_APPLY_NEXT_TRADES",
      payload: { keys },
    });
    this.runtimeMessage = "Config applied for next trades.";
    return { applied: true };
  }

  getStatus(): Status {
    return {
      sessionState: this.sessionState,
      sessionId: this.sessionId,
      eventsFile: this.logger?.filePath ?? null,
      summaryFile: this.summaryFilePath,
      runningSinceMs: this.runningSinceMs,
      runtimeMessage: this.runtimeMessage,
      runningBotId: this.runContext?.botId ?? null,
      runningBotName: this.runContext?.botName ?? null,
    };
  }

  isRunning() {
    return this.sessionState === "RUNNING";
  }

  async start(opts?: StartOptions): Promise<Status> {
    if (this.sessionState !== "STOPPED") {
      await this.stop("restart_before_start");
    }

    this.sessionId = newSessionId();
    const runId = this.sessionId;
    const abortController = new AbortController();
    const botDef = getBotDefinition(configStore.get().selectedBotId);
    this.runContext = {
      runId,
      abortController,
      startedAt: Date.now(),
      stopRequestedAt: null,
      botId: botDef.id,
      botName: botDef.name,
    };
    this.summaryFilePath = null;
    this.demoStartedAtMs = null;
    this.runningSinceMs = null;
    this.runtimeMessage = null;
    this.resetRiskState(Date.now());

    this.closedTrades = [];
    this.stopTransientBrokers();
    this.attachLogger(this.sessionId);

    const cfg = configStore.get();
    if (cfg.execution.mode === "demo") {
      this.paper = null;
      this.real = null;
      this.demo = new DemoBroker(cfg.paper, this.logger!, this.sessionId ?? "run", this.getMarkPrice ?? undefined);
      this.demo.start();
    } else if (cfg.execution.mode === "real") {
      this.paper = null;
      this.demo = null;
      this.real = new RealBroker(cfg.paper, this.logger!, this.sessionId ?? "run", this.getMarkPrice ?? undefined);
      this.real.start();
    } else if (cfg.execution.mode === "empty") {
      this.paper = null;
      this.demo = null;
      this.real = null;
    } else {
      this.demo = null;
      this.real = null;
      this.paper = new PaperBrokerPool(cfg.paper, this.logger!, this.sessionId ?? "run");
    }

    this.transitionState("RESUMING");
    this.emit("state", this.getStatus());

    try {
      await opts?.waitForReady?.({ runId, signal: abortController.signal });
    } catch (err) {
      this.logSessionStopRequested("start_wait_for_ready_failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
      this.runtimeMessage = err instanceof Error ? err.message : String(err);
      this.transitionState("STOPPED");
      this.logger?.log({
        ts: Date.now(),
        type: "SESSION_STOP",
        payload: {
          sessionId: this.sessionId,
          stopDurationMs: 0,
          source: "start_wait_for_ready_failed",
          runtimeMessage: this.runtimeMessage,
        },
      });
      this.stopTransientBrokers();
      await this.closeLoggerSafely();
      this.demoStartedAtMs = null;
      this.runningSinceMs = null;
      this.runContext = null;
      const status = this.getStatus();
      this.emit("state", status);
      return status;
    }

    if (abortController.signal.aborted || this.runContext?.runId !== runId) {
      this.logSessionStopRequested("start_aborted_after_ready", {
        aborted: abortController.signal.aborted,
        activeRunId: this.runContext?.runId ?? null,
        expectedRunId: runId,
      });
      this.runtimeMessage = "start_aborted_after_ready";
      this.transitionState("STOPPED");
      this.logger?.log({
        ts: Date.now(),
        type: "SESSION_STOP",
        payload: {
          sessionId: this.sessionId,
          stopDurationMs: 0,
          source: "start_aborted_after_ready",
          runtimeMessage: this.runtimeMessage,
        },
      });
      this.stopTransientBrokers();
      await this.closeLoggerSafely();
      this.demoStartedAtMs = null;
      this.runningSinceMs = null;
      this.runContext = null;
      const status = this.getStatus();
      this.emit("state", status);
      return status;
    }

    this.transitionState("RUNNING");
    this.runningSinceMs = Date.now();
    if (cfg.execution.mode === "demo" && this.demo) {
      this.demoStartedAtMs = this.runningSinceMs;
      this.demo.sessionStartBalanceUsdt = await this.withAbortAndTimeout(this.demo.getWalletUsdtBalance(), {
        signal: abortController.signal,
        timeoutMs: STARTUP_OPERATION_TIMEOUT_MS,
        label: "demo_session_start_balance",
      });
    } else if (cfg.execution.mode === "real" && this.real) {
      this.demoStartedAtMs = this.runningSinceMs;
      this.real.sessionStartBalanceUsdt = await this.withAbortAndTimeout(this.real.getWalletUsdtBalance(), {
        signal: abortController.signal,
        timeoutMs: STARTUP_OPERATION_TIMEOUT_MS,
        label: "real_session_start_balance",
      });
    }

    const status = this.getStatus();
    this.emit("state", status);
    return status;
  }

  async stop(reason = "unspecified"): Promise<Status> {
    if (this.sessionState === "STOPPED") {
      const status = this.getStatus();
      this.emit("state", status);
      return status;
    }

    if (this.stopPromise) return this.stopPromise;

    this.logSessionStopRequested(reason);
    const stopStartedAt = Date.now();
    this.stopPromise = (async () => {
      if (this.sessionState !== "STOPPING") {
        this.transitionState("STOPPING");
        this.emit("state", this.getStatus());
      }

      const runCtx = this.runContext;
      if (runCtx) {
        runCtx.stopRequestedAt = Date.now();
        runCtx.abortController.abort();
      }

      const stopSignal = runCtx?.abortController.signal ?? new AbortController().signal;

      try {
        const now = Date.now();
        if (this.paper) {
          const provider = this.getMarkPrice ?? (() => null);
          this.paper.stopAll({
            nowMs: now,
            symbols: [],
            getMarkPrice: provider
          });
        }
        if (this.demo) {
          const demoEndedAtMs = Date.now();
          let endBalanceUsdt: number | null = null;
          try {
            endBalanceUsdt = await this.withAbortAndTimeout(this.demo.getWalletUsdtBalance(), {
              signal: stopSignal,
              timeoutMs: STOP_OPERATION_TIMEOUT_MS,
              label: "demo_session_end_balance",
            });
          } catch {
            endBalanceUsdt = null;
          }
          this.demo.sessionEndBalanceUsdt = endBalanceUsdt;
          const stats = this.demo.getStats();
          const startBalanceUsdt = this.demo.sessionStartBalanceUsdt;
          const deltaUsdt = startBalanceUsdt != null && endBalanceUsdt != null ? endBalanceUsdt - startBalanceUsdt : null;
          const demoSummary = {
            sessionId: this.sessionId,
            executionMode: "demo" as const,
            startedAtMs: this.demoStartedAtMs,
            endedAtMs: demoEndedAtMs,
            startBalanceUsdt,
            endBalanceUsdt,
            deltaUsdt,
            openPositionsAtEnd: stats.openPositions,
            openOrdersAtEnd: stats.openOrders,
            pendingEntriesAtEnd: stats.pendingEntries,
            tradesCount: stats.closedTrades,
            realizedPnlUsdt: stats.realizedPnlUsdt,
            feesUsdt: stats.feesUsdt,
            lastExecTimeMs: stats.lastExecTimeMs,
          };
          const sessionDir = this.logger?.filePath ? path.dirname(this.logger.filePath) : null;
          if (sessionDir) {
            fs.mkdirSync(sessionDir, { recursive: true });
            const outPath = path.join(sessionDir, "demo_summary.json");
            const tempPath = `${outPath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(demoSummary, null, 2), "utf8");
            fs.renameSync(tempPath, outPath);
          }
          this.demo.stop();
          this.demo = null;
        }
        if (this.real) {
          const realEndedAtMs = Date.now();
          let endBalanceUsdt: number | null = null;
          try {
            endBalanceUsdt = await this.withAbortAndTimeout(this.real.getWalletUsdtBalance(), {
              signal: stopSignal,
              timeoutMs: STOP_OPERATION_TIMEOUT_MS,
              label: "real_session_end_balance",
            });
          } catch {
            endBalanceUsdt = null;
          }
          this.real.sessionEndBalanceUsdt = endBalanceUsdt;
          const stats = this.real.getRealStats();
          const startBalanceUsdt = this.real.sessionStartBalanceUsdt;
          const deltaUsdt = startBalanceUsdt != null && endBalanceUsdt != null ? endBalanceUsdt - startBalanceUsdt : null;
          const realSummary = {
            sessionId: this.sessionId,
            executionMode: "real" as const,
            startedAtMs: this.demoStartedAtMs,
            endedAtMs: realEndedAtMs,
            startBalanceUsdt,
            endBalanceUsdt,
            deltaUsdt,
            openPositionsAtEnd: stats.openPositions,
            openOrdersAtEnd: stats.openOrders,
            pendingEntriesAtEnd: stats.pendingEntries,
            tradesCount: stats.closedTrades,
            realizedPnlUsdt: stats.realizedPnlUsdt,
            feesUsdt: stats.feesUsdt,
            fundingUsdt: stats.fundingUsdt,
            lastExecTimeMs: stats.lastExecTimeMs,
          };
          const sessionDir = this.logger?.filePath ? path.dirname(this.logger.filePath) : null;
          if (sessionDir) {
            fs.mkdirSync(sessionDir, { recursive: true });
            const outPath = path.join(sessionDir, "real_summary.json");
            const tempPath = `${outPath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(realSummary, null, 2), "utf8");
            fs.renameSync(tempPath, outPath);
          }
          this.real.stop();
          this.real = null;
        }
      } finally {
        this.paper = null;
        this.demoStartedAtMs = null;
        this.runningSinceMs = null;
        this.runContext = null;

        this.transitionState("STOPPED");

        const eventsFile = this.logger?.filePath ?? null;
        const stopDurationMs = Date.now() - stopStartedAt;
        this.logger?.log({ ts: Date.now(), type: "SESSION_STOP", payload: { sessionId: this.sessionId, stopDurationMs, source: reason } });
        await this.closeLoggerSafely();

        if (eventsFile) {
          try {
            const outFile = getSummaryFilePathFromEventsFile(eventsFile);
            const data = computePaperSummaryFromEvents({ sessionId: this.sessionId, eventsFile });
            persistSummaryFile(outFile, data);
            this.summaryFilePath = outFile;
          } catch {
            this.summaryFilePath = null;
          }
        }
      }

      const status = this.getStatus();
      this.emit("state", status);
      return status;
    })();

    const stopRunId = this.runContext?.runId ?? this.sessionId;
    let stopOverallTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Status>((resolve) => {
      stopOverallTimer = setTimeout(() => {
        const currentRunId = this.runContext?.runId ?? this.sessionId;
        if (currentRunId !== stopRunId) {
          return;
        }
        if (this.sessionState !== "STOPPED") {
          this.logSessionStopRequested("stop_timeout_fallback", { originalSource: reason });
          this.stopTransientBrokers();
          this.demoStartedAtMs = null;
          this.runningSinceMs = null;
          this.runContext = null;
          this.transitionState("STOPPED");
          void this.closeLoggerSafely();
          const status = this.getStatus();
          this.emit("state", status);
          resolve(status);
        }
      }, STOP_OVERALL_TIMEOUT_MS);
    });

    try {
      return await Promise.race([this.stopPromise, timeoutPromise]);
    } finally {
      if (stopOverallTimer) {
        clearTimeout(stopOverallTimer);
      }
      this.stopPromise = null;
    }
  }

  pause(): Status {
    if (this.sessionState !== "RUNNING") {
      const status = this.getStatus();
      this.emit("state", status);
      return status;
    }

    this.sessionState = "PAUSING";
    this.logger?.log({
      ts: Date.now(),
      type: "SESSION_STATE",
      payload: { state: this.sessionState, sessionId: this.sessionId }
    });
    this.emit("state", this.getStatus());

    this.sessionState = "PAUSED";
    this.logger?.log({
      ts: Date.now(),
      type: "SESSION_STATE",
      payload: { state: this.sessionState, sessionId: this.sessionId }
    });

    if (this.demo) this.demo.stop();
    if (this.real) this.real.stop();

    const status = this.getStatus();
    this.emit("state", status);
    return status;
  }

  resume(): Status {
    if (this.sessionState !== "PAUSED") {
      const status = this.getStatus();
      this.emit("state", status);
      return status;
    }

    if (this.emergencyStopActive) {
      if (this.emergencyStopReason) {
        this.runtimeMessage = `Emergency stop: ${this.emergencyStopReason}`;
      }
      const status = this.getStatus();
      this.emit("state", status);
      return status;
    }

    this.transitionState("RUNNING");
    if (this.runningSinceMs == null) this.runningSinceMs = Date.now();
    if (this.demo) this.demo.start();
    if (this.real) this.real.start();

    const status = this.getStatus();
    this.emit("state", status);
    return status;
  }

  getBotStats(): RuntimeBotStats {
    return buildRuntimeBotStats({
      paper: this.paper,
      demo: this.demo,
      real: this.real,
    });
  }

  getPaperView(symbol: string, markPrice: number | null): PaperView {
    return resolveRuntimePaperView({
      paper: this.paper,
      demo: this.demo,
      real: this.real,
      symbol,
      markPrice,
    });
  }

  async submitManualTestOrder(args: {
    symbol: string;
    side: "LONG" | "SHORT";
    executionModeOverride?: "demo" | "real";
    nowMs: number;
    markPrice: number;
    fundingRate: number;
    nextFundingTime: number;
    entryPrice?: number;
    tpPrice?: number;
    slPrice?: number;
    maxTradesPerSymbol?: number;
    configOverride?: Partial<{
      marginUSDT: number;
      leverage: number;
      entryOffsetPct: number;
      entryTimeoutSec: number;
      tpRoiPct: number;
      slRoiPct: number;
      rearmDelayMs: number;
      applyFunding: boolean;
      directionMode: "both" | "long" | "short";
    }>;
  }): Promise<ManualTestOrderResult> {
    return submitRuntimeManualTestOrder({
      logger: this.logger,
      ensureManualBroker: (executionMode) => this.ensureManualBroker(executionMode),
      getPaperBroker: () => this.paper,
      getDemoBroker: () => this.demo,
      getRealBroker: () => this.real,
      getPaperView: (symbol, markPrice) => this.getPaperView(symbol, markPrice),
      evaluateEntryAllowance: (symbol, nowMs, maxTradesPerSymbol, side) => this.evaluateEntryAllowance(symbol, nowMs, maxTradesPerSymbol, side),
      setRuntimeMessage: (message) => {
        this.runtimeMessage = message;
      },
    }, args);
  }

  tickPaper(args: {
    symbol: string;
    nowMs: number;
    markPrice: number;
    fundingRate: number;
    nextFundingTime: number;
    signal: "LONG" | "SHORT" | null;
    signalReason: string;
    cooldownActive: boolean;
    maxTradesPerSymbol?: number;
    configOverride?: Partial<{
      entryOffsetPct: number;
      entryTimeoutSec: number;
      tpRoiPct: number;
      slRoiPct: number;
      rearmDelayMs: number;
      applyFunding: boolean;
      directionMode: "both" | "long" | "short";
    }>;
  }) {
    dispatchRuntimeTick({
      logger: this.logger,
      paper: this.paper,
      demo: this.demo,
      real: this.real,
      isRunning: () => this.isRunning(),
      evaluateEntryAllowance: (symbol, nowMs, maxTradesPerSymbol, side) => this.evaluateEntryAllowance(symbol, nowMs, maxTradesPerSymbol, side),
      recordRecentEntryAttempt: (symbol, side, nowMs) => this.recordRecentEntryAttempt(symbol, side, nowMs),
    }, args);
  }

  getTradeStatsBySymbol(mode: "both" | "long" | "short", symbols: string[]): TradeStatsBySymbolRow[] {
    const rows = new Map<string, TradeStatsBySymbolRow>();
    for (const symbol of symbols) {
      rows.set(symbol, {
        symbol,
        trades: 0,
        wins: 0,
        losses: 0,
        netPnl: 0,
        fees: 0,
        funding: 0,
        lastCloseTs: null,
        longTrades: 0,
        longWins: 0,
        shortTrades: 0,
        shortWins: 0,
      });
    }

    for (const trade of this.closedTrades) {
      if (!rows.has(trade.symbol)) continue;
      if (mode === "long" && trade.side !== "LONG") continue;
      if (mode === "short" && trade.side !== "SHORT") continue;
      const row = rows.get(trade.symbol)!;
      row.trades += 1;
      if (trade.realizedPnl > 0) row.wins += 1;
      else row.losses += 1;
      row.netPnl += trade.realizedPnl;
      row.fees += trade.feesPaid;
      row.funding += trade.fundingAccrued;
      row.lastCloseTs = row.lastCloseTs == null ? trade.closedAt : Math.max(row.lastCloseTs, trade.closedAt);
      if (trade.side === "LONG") {
        row.longTrades += 1;
        if (trade.realizedPnl > 0) row.longWins += 1;
      } else {
        row.shortTrades += 1;
        if (trade.realizedPnl > 0) row.shortWins += 1;
      }
    }

    if (mode === "long") {
      for (const row of rows.values()) {
        row.shortTrades = 0;
        row.shortWins = 0;
      }
    }
    if (mode === "short") {
      for (const row of rows.values()) {
        row.longTrades = 0;
        row.longWins = 0;
      }
    }

    return symbols.map((symbol) => rows.get(symbol)!);
  }

  getTradeExcursionsBySymbol(symbols: string[]): TradeExcursionsRow[] {
    const rows = new Map<string, TradeExcursionsRow>();
    for (const symbol of symbols) {
      rows.set(symbol, {
        symbol,
        tpTrades: 0,
        tpWorstMinRoiPct: null,
        slTrades: 0,
        slBestMaxRoiPct: null,
      });
    }

    for (const trade of this.closedTrades) {
      if (!rows.has(trade.symbol)) continue;
      const row = rows.get(trade.symbol)!;
      if (trade.closeType === "TP") {
        row.tpTrades += 1;
        if (trade.minRoiPct != null) {
          row.tpWorstMinRoiPct = row.tpWorstMinRoiPct == null ? trade.minRoiPct : Math.min(row.tpWorstMinRoiPct, trade.minRoiPct);
        }
      }
      if (trade.closeType === "SL") {
        row.slTrades += 1;
        if (trade.maxRoiPct != null) {
          row.slBestMaxRoiPct = row.slBestMaxRoiPct == null ? trade.maxRoiPct : Math.max(row.slBestMaxRoiPct, trade.maxRoiPct);
        }
      }
    }

    return symbols.map((symbol) => rows.get(symbol)!);
  }
}

export const runtime = new Runtime();
