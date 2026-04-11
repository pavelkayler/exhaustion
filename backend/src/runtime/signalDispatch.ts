import { configStore } from "./configStore.js";
import { runtimeDiagnostics } from "./runtimeDiagnostics.js";
import type { DemoBroker } from "../demo/DemoBroker.js";
import type { EventLogger } from "../logging/EventLogger.js";
import type { PaperBrokerPool } from "../paper/PaperBrokerPool.js";
import type { PaperBroker } from "../paper/PaperBroker.js";
import type { RealBroker } from "../real/RealBroker.js";

type RuntimeTickArgs = {
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
};

type DispatchRuntimeTickDeps = {
  logger: EventLogger | null;
  paper: PaperBrokerPool | PaperBroker | null;
  demo: DemoBroker | null;
  real: RealBroker | null;
  isRunning: () => boolean;
  evaluateEntryAllowance: (symbol: string, nowMs: number, maxTradesPerSymbol?: number, side?: "LONG" | "SHORT") => { allowed: boolean; reason?: string };
  recordRecentEntryAttempt: (symbol: string, side: "LONG" | "SHORT", nowMs: number) => void;
};

export function dispatchRuntimeTick(deps: DispatchRuntimeTickDeps, args: RuntimeTickArgs): void {
  const measure = runtimeDiagnostics.start("runtime.dispatch_tick");
  let failed = false;
  try {
    if (!deps.isRunning()) return;
    const mode = configStore.get().execution.mode;
    if (mode === "empty") return;
    if (args.signal) {
      deps.logger?.log({
        ts: args.nowMs,
        type: "BOT_SIGNAL_EMITTED",
        symbol: args.symbol,
        payload: {
          brokerMode: mode,
          signal: args.signal,
          signalReason: args.signalReason,
          cooldownActive: args.cooldownActive,
          maxTradesPerSymbol: Math.max(1, Math.floor(Number(args.maxTradesPerSymbol) || 1)),
          markPrice: args.markPrice,
          fundingRate: args.fundingRate,
          nextFundingTime: args.nextFundingTime,
        },
      });
    }
    const shouldCheckEntry = args.signal != null && !args.cooldownActive;
    const entryAllowance = !shouldCheckEntry
      ? { allowed: true as const }
      : deps.evaluateEntryAllowance(args.symbol, args.nowMs, args.maxTradesPerSymbol ?? 1, args.signal ?? undefined);
    if (!entryAllowance.allowed && args.signal) {
      deps.logger?.log({
        ts: args.nowMs,
        type: "SIGNAL_BLOCKED",
        symbol: args.symbol,
        payload: {
          signal: args.signal,
          signalReason: args.signalReason,
          reason: entryAllowance.reason ?? "risk_limits_blocked",
          maxTradesPerSymbol: Math.max(1, Math.floor(Number(args.maxTradesPerSymbol) || 1)),
        },
      });
    }
    const nextArgs = entryAllowance.allowed
      ? args
      : { ...args, signal: null, signalReason: `${entryAllowance.reason ?? "risk_limits_blocked"}:${args.signalReason || "entry"}` };
    if (entryAllowance.allowed && args.signal) {
      deps.logger?.log({
        ts: args.nowMs,
        type: "BOT_ORDER_REQUESTED",
        symbol: args.symbol,
        payload: {
          brokerMode: mode,
          signal: args.signal,
          signalReason: args.signalReason,
          markPrice: args.markPrice,
          fundingRate: args.fundingRate,
          nextFundingTime: args.nextFundingTime,
          maxTradesPerSymbol: Math.max(1, Math.floor(Number(args.maxTradesPerSymbol) || 1)),
        },
      });
    }
    if (mode === "demo") {
      if (!deps.demo) return;
      void deps.demo.tick(nextArgs);
      return;
    }
    if (mode === "real") {
      if (!deps.real) return;
      void deps.real.tick(nextArgs);
      return;
    }
    if (!deps.paper) return;
    deps.paper.tick(nextArgs);
    if (entryAllowance.allowed && args.signal) {
      deps.recordRecentEntryAttempt(args.symbol, args.signal, args.nowMs);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    measure.end({ items: 1, failed });
  }
}
