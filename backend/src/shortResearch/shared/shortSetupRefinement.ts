import type { ShortSignalMinuteBar, ShortSignalOutcomeRecord } from "../../analytics/shortSignalOutcomeTypes.js";
import type { ShortExhaustionBotConfig } from "../../bots/registry.js";
import type {
  ShortReplaySetupOutcomeRecord,
  ShortReplaySetupRecord,
  ShortReplaySetupRevisionRecord,
  ShortReplaySignalRecord,
} from "../replay/shortReplayTypes.js";

const ONE_MIN_MS = 60_000;
const SHORT_SETUP_VERSION = "short-setup-v1.1";
const SHORT_SETUP_RULES_VERSION = "short-setup-rules-v1.1";

type BuildLifecycleArgs = {
  runId: string;
  setupId: string;
  signal: ShortReplaySignalRecord;
  outcome: { referencePrice: number | null } | null;
  bars: ShortSignalMinuteBar[];
  shortCfg: ShortExhaustionBotConfig;
  promotedSignal?: ShortReplaySignalRecord | null;
  nowMs?: number;
  tuning?: Partial<ShortSetupTuningParams>;
};

export type ShortSetupTuningParams = {
  entryZoneWidthScale: number;
  invalidationBufferScale: number;
  tp1RiskMultiple: number;
  tp2RiskMultiple: number;
  expiryCandles: number;
  tooLateRrThreshold: number;
};

export const DEFAULT_SHORT_SETUP_TUNING: ShortSetupTuningParams = {
  entryZoneWidthScale: 1,
  invalidationBufferScale: 1,
  tp1RiskMultiple: 1.25,
  tp2RiskMultiple: 2.1,
  expiryCandles: 6,
  tooLateRrThreshold: 0.9,
};

type EvaluateOutcomeSummary = {
  didEnter: boolean;
  entryTs: number | null;
  entryPrice: number | null;
  didHitTp1: boolean;
  didHitTp2: boolean;
  didInvalidateFirst: boolean;
  invalidated: boolean;
  invalidationTs: number | null;
  invalidationPrice: number | null;
  tp1Ts: number | null;
  tp1Price: number | null;
  tp2Ts: number | null;
  tp2Price: number | null;
  expired: boolean;
  maxFavorableMove: number | null;
  maxAdverseMove: number | null;
  bestRrAchieved: number | null;
  timeToTp1Ms: number | null;
  timeToTp2Ms: number | null;
  timeToInvalidationMs: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveShortSetupTuning(
  shortCfg: ShortExhaustionBotConfig | null | undefined,
  overrides?: Partial<ShortSetupTuningParams> | null,
): ShortSetupTuningParams {
  return {
    ...DEFAULT_SHORT_SETUP_TUNING,
    expiryCandles: Math.max(3, Number(shortCfg?.strategy?.expiryCandles ?? DEFAULT_SHORT_SETUP_TUNING.expiryCandles) || DEFAULT_SHORT_SETUP_TUNING.expiryCandles),
    ...overrides,
  };
}

function findSignalBar(signalTs: number, bars: ShortSignalMinuteBar[]): ShortSignalMinuteBar | null {
  return bars.find((bar) => bar.startMs <= signalTs && bar.endMs >= signalTs)
    ?? bars.find((bar) => bar.endMs >= signalTs)
    ?? null;
}

function buildConfidenceBreakdown(args: {
  totalScore: number;
  rr: number | null;
  entryMode: ShortReplaySetupRecord["entryMode"];
  tradabilityStatus: ShortReplaySetupRecord["tradabilityStatus"];
  decayPenalty: number;
}): ShortReplaySetupRecord["confidenceBreakdown"] {
  const signalContext = clamp(args.totalScore / 4.5, 0, 1);
  const rrQuality = clamp((args.rr ?? 0) / 2.5, 0, 1);
  const entryQuality = args.entryMode === "market_now" ? 0.72 : args.entryMode === "confirmation_breakdown" ? 0.78 : 0.85;
  const invalidationQuality = args.tradabilityStatus === "not_tradable" ? 0.2 : args.tradabilityStatus === "too_late" ? 0.52 : 0.82;
  const targetQuality = clamp(((args.rr ?? 0) * 0.55), 0.2, 0.95);
  return {
    signalContext,
    entryQuality,
    invalidationQuality,
    targetQuality,
    rrQuality,
    decayPenalty: clamp(args.decayPenalty, 0, 1),
  };
}

function recalcSetupGeometry(args: {
  record: ShortReplaySetupRecord;
  signal: ShortReplaySignalRecord;
  bars: ShortSignalMinuteBar[];
  signalBar: ShortSignalMinuteBar | null;
  setupHighOverride?: number | null;
  decayPenalty?: number;
  tuning?: Partial<ShortSetupTuningParams>;
}): ShortReplaySetupRecord {
  const next = clone(args.record);
  const tuning = resolveShortSetupTuning(null, args.tuning);
  const setupReferencePrice = next.setupReferencePrice ?? args.signalBar?.close ?? null;
  if (setupReferencePrice == null || setupReferencePrice <= 0) return next;
  const historyBars = args.bars.filter((bar) => bar.endMs <= args.signal.signalTs).slice(-8);
  const signalHigh = Math.max(...[args.signalBar?.high ?? setupReferencePrice, ...historyBars.map((bar) => bar.high)]);
  const setupHigh = Number.isFinite(Number(args.setupHighOverride)) ? Number(args.setupHighOverride) : signalHigh;
  const localPullbackLow = historyBars.length ? Math.min(...historyBars.slice(-3).map((bar) => bar.low)) : args.signalBar?.low ?? setupReferencePrice;
  const deeperReturnLow = historyBars.length ? Math.min(...historyBars.map((bar) => bar.low)) : localPullbackLow;
  const structuralRisk = Math.max(setupHigh - setupReferencePrice, setupReferencePrice * 0.0025);
  const orderbookBoost = (Number(next.reasons.some((reason) => reason.startsWith("orderbook_modifier:")) ? 1 : 0)) * 0.03;
  const widthScale = clamp(tuning.entryZoneWidthScale, 0.4, 2.5);
  const invalidationBufferScale = clamp(tuning.invalidationBufferScale, 0.4, 2.5);
  const tp1RiskMultiple = clamp(tuning.tp1RiskMultiple, 0.4, 4);
  const tp2RiskMultiple = Math.max(tp1RiskMultiple + 0.1, clamp(tuning.tp2RiskMultiple, 0.8, 6));
  const tooLateRrThreshold = clamp(tuning.tooLateRrThreshold, 0.2, 3.5);

  let entryZoneLow = setupReferencePrice;
  let entryZoneHigh = setupReferencePrice;
  if (next.entryMode === "limit_on_retest") {
    entryZoneLow = Math.max(
      setupReferencePrice,
      setupHigh - Math.max(structuralRisk * ((0.45 + orderbookBoost) * widthScale), setupReferencePrice * (0.0015 * widthScale)),
    );
    entryZoneHigh = Math.max(
      entryZoneLow,
      setupHigh - Math.max(structuralRisk * (0.1 * widthScale), setupReferencePrice * (0.0005 * widthScale)),
    );
  } else if (next.entryMode === "confirmation_breakdown") {
    const breakdownLow = Math.min(setupReferencePrice, args.signalBar?.low ?? setupReferencePrice);
    const breakdownDistance = Math.max(0, setupReferencePrice - breakdownLow) * widthScale;
    entryZoneLow = setupReferencePrice - breakdownDistance;
    entryZoneHigh = Math.max(entryZoneLow, setupReferencePrice);
  } else {
    entryZoneLow = setupReferencePrice * (1 - (0.001 * widthScale));
    entryZoneHigh = setupReferencePrice * (1 + (0.001 * widthScale));
  }
  const entryPriceMid = (entryZoneLow + entryZoneHigh) / 2;
  const invalidationPrice = next.invalidationPrice ?? (
    setupHigh + Math.max(setupReferencePrice * (0.0015 * invalidationBufferScale), structuralRisk * (0.15 * invalidationBufferScale))
  );
  const invalidationPctFromReference = (invalidationPrice - setupReferencePrice) / setupReferencePrice;
  const target1Price = Math.min(entryPriceMid - (structuralRisk * tp1RiskMultiple), localPullbackLow);
  const target2Price = Math.min(entryPriceMid - (structuralRisk * tp2RiskMultiple), deeperReturnLow);
  const risk = invalidationPrice - entryPriceMid;
  const rrToTp1 = risk > 0 ? Math.max(0, (entryPriceMid - target1Price) / risk) : null;
  const rrToTp2 = risk > 0 ? Math.max(0, (entryPriceMid - target2Price) / risk) : null;
  const expectedRr = rrToTp2 ?? rrToTp1;

  next.entryZoneLow = entryZoneLow;
  next.entryZoneHigh = entryZoneHigh;
  next.entryPriceMid = entryPriceMid;
  next.invalidationPctFromReference = invalidationPctFromReference;
  next.target1Price = target1Price;
  next.target2Price = target2Price;
  next.rrToTp1 = rrToTp1;
  next.rrToTp2 = rrToTp2;
  next.expectedRr = expectedRr;
  next.anchors.signalHigh = signalHigh;
  next.anchors.setupHigh = setupHigh;
  next.anchors.rejectionCandleHigh = args.signalBar?.high ?? next.anchors.rejectionCandleHigh;
  next.anchors.signalBarStartMs = args.signalBar?.startMs ?? next.anchors.signalBarStartMs;

  const confidence = clamp(args.signal.totalScore / 4.5, 0, 1);
  const decayPenalty = args.decayPenalty ?? next.confidenceBreakdown.decayPenalty ?? 0;
  next.confidence = clamp(confidence - (decayPenalty * 0.18), 0, 1);
  next.confidenceBreakdown = buildConfidenceBreakdown({
    totalScore: args.signal.totalScore,
    rr: expectedRr,
    entryMode: next.entryMode,
    tradabilityStatus: next.tradabilityStatus,
    decayPenalty,
  });
  next.setupQualityScore = clamp(
    (next.confidenceBreakdown.signalContext * 1.2)
    + (next.confidenceBreakdown.entryQuality * 0.9)
    + (next.confidenceBreakdown.invalidationQuality * 1.3)
    + (next.confidenceBreakdown.targetQuality * 0.8)
    + (next.confidenceBreakdown.rrQuality * 1.6)
    - (next.confidenceBreakdown.decayPenalty * 1.1),
    0,
    5,
  );

  if ((expectedRr ?? 0) < tooLateRrThreshold && next.tradabilityStatus === "tradable") {
    next.tradabilityStatus = "too_late";
  }
  if (entryZoneLow >= invalidationPrice || target1Price >= entryPriceMid) {
    next.tradabilityStatus = next.setupType === "shadow" ? "shadow" : "not_tradable";
  }
  next.isTradableNow = next.tradabilityStatus === "tradable";

  next.whyTradableSummary = next.setupType === "shadow"
    ? "Suppressed setup kept as a shadow short idea for review, not for action."
    : next.tradabilityStatus === "too_late"
      ? "The short idea is still alive, but the move has already stretched enough to damage the reward relative to the risk."
      : next.tradabilityStatus === "not_tradable"
        ? "The pump still looks tired, but current prices no longer offer a clean short with defined risk above structure."
        : "Price still looks stretched, risk stays capped above structure, and the nearest pullback targets still justify the short.";

  return next;
}

function summarizeChangedFields(prev: ShortReplaySetupRecord, next: ShortReplaySetupRecord): string[] {
  const changed: string[] = [];
  const fields: Array<keyof ShortReplaySetupRecord> = [
    "setupState",
    "tradabilityStatus",
    "setupStyle",
    "entryMode",
    "entryZoneLow",
    "entryZoneHigh",
    "invalidationPrice",
    "target1Price",
    "target2Price",
    "setupQualityScore",
    "confidence",
    "isWeakened",
    "degradationReason",
  ];
  for (const field of fields) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      changed.push(String(field));
    }
  }
  return changed;
}

function buildBaseSetup(args: BuildLifecycleArgs): ShortReplaySetupRecord | null {
  const tuning = resolveShortSetupTuning(args.shortCfg, args.tuning);
  const signalBar = findSignalBar(args.signal.signalTs, args.bars);
  const historyBars = args.bars.filter((bar) => bar.endMs <= args.signal.signalTs).slice(-8);
  const setupReferencePrice = args.outcome?.referencePrice ?? signalBar?.close ?? null;
  if (setupReferencePrice == null || setupReferencePrice <= 0) return null;

  let entryMode: ShortReplaySetupRecord["entryMode"] = "limit_on_retest";
  let setupStyle: ShortReplaySetupRecord["setupStyle"] = "standard";
  let setupState: ShortReplaySetupRecord["setupState"] = "active";
  let tradabilityStatus: ShortReplaySetupRecord["tradabilityStatus"] = "tradable";
  let setupType: ShortReplaySetupRecord["setupType"] = "primary";
  if (args.signal.terminalState === "CANDIDATE") {
    entryMode = "limit_on_retest";
    setupStyle = "standard";
    setupState = "active";
  } else if (args.signal.terminalState === "CONFIRMED") {
    entryMode = "confirmation_breakdown";
    setupStyle = "conservative";
    setupState = "draft";
  } else if (args.signal.terminalState === "SOFT_FINAL") {
    entryMode = "limit_on_retest";
    setupStyle = "conservative";
    setupState = "active";
  } else if (args.signal.terminalState === "SUPPRESSED") {
    setupState = "shadow";
    tradabilityStatus = "shadow";
    setupType = "shadow";
  } else if (args.signal.finalTriggerEmitted && args.signal.totalScore >= 3.75) {
    entryMode = "market_now";
    setupStyle = "aggressive";
  }

  const referenceAskBias = Number(args.signal.compactSnapshot.metrics.askToBidDepthRatio ?? 0);
  const reasons = [
    ...args.signal.compactSnapshot.reasons.slice(0, 4),
    `entry_mode:${entryMode}`,
    `setup_state:${setupState}`,
    ...(referenceAskBias > 1.1 ? [`orderbook_modifier:${referenceAskBias.toFixed(2)}`] : []),
  ];

  const base: ShortReplaySetupRecord = {
    id: args.setupId,
    runId: args.runId,
    signalId: args.signal.id,
    symbol: args.signal.symbol,
    sourceSignalState: args.signal.terminalState as "CANDIDATE" | "CONFIRMED" | "SOFT_FINAL" | "FINAL" | "SUPPRESSED",
    setupState,
    tradabilityStatus,
    setupType,
    setupStyle,
    entryMode,
    entryZoneLow: null,
    entryZoneHigh: null,
    entryPriceMid: null,
    setupReferencePrice,
    invalidationPrice: null,
    invalidationPctFromReference: null,
    invalidationType: "structural_high",
    target1Price: null,
    target2Price: null,
    rrToTp1: null,
    rrToTp2: null,
    expectedRr: null,
    setupQualityScore: 0,
    confidence: 0,
    reasons,
    setupRationale: [
      `Entry geometry starts from exhaustion structure in ${entryMode} mode.`,
      "Primary invalidation stays above structural setup high.",
      "Targets anchor to local pullback structure with deeper pre-pump return as TP2.",
    ],
    whyTradableSummary: "",
    lastRevisionReason: "created",
    isWeakened: false,
    degradationReason: null,
    confidenceBreakdown: {
      signalContext: 0,
      entryQuality: 0,
      invalidationQuality: 0,
      targetQuality: 0,
      rrQuality: 0,
      decayPenalty: 0,
    },
    anchors: {
      signalHigh: null,
      rejectionCandleHigh: signalBar?.high ?? null,
      finalTriggerCandleHigh: args.signal.finalTriggerEmitted ? signalBar?.high ?? null : null,
      setupHigh: null,
      signalBarStartMs: signalBar?.startMs ?? null,
    },
    isTradableNow: tradabilityStatus === "tradable",
    supersedesSetupId: null,
    supersededBySetupId: null,
    setupExpiryTs: args.signal.signalTs + (Math.max(3, tuning.expiryCandles) * Math.max(1, args.shortCfg.strategy.signalTfMin) * ONE_MIN_MS),
    revision: 1,
    setupVersion: SHORT_SETUP_VERSION,
    setupRulesVersion: SHORT_SETUP_RULES_VERSION,
    createdAtMs: args.signal.signalTs,
    updatedAtMs: args.signal.signalTs,
    outcomeId: null,
  };

  return recalcSetupGeometry({
    record: base,
    signal: args.signal,
    bars: historyBars,
    signalBar,
    tuning,
  });
}

export function buildShortSetupLifecycle(args: BuildLifecycleArgs): {
  current: ShortReplaySetupRecord;
  original: ShortReplaySetupRecord;
  revisions: ShortReplaySetupRevisionRecord[];
} | null {
  const base = buildBaseSetup(args);
  if (!base) return null;
  const revisions: ShortReplaySetupRevisionRecord[] = [{
    id: `${args.runId}:setup-revision:${args.setupId}:1`,
    runId: args.runId,
    setupId: args.setupId,
    signalId: args.signal.id,
    symbol: args.signal.symbol,
    revision: 1,
    ts: base.createdAtMs,
    reasonCode: "created",
    changedFields: [],
    note: base.whyTradableSummary,
    snapshot: clone(base),
  }];
  let current = clone(base);
  let signalBar = findSignalBar(args.signal.signalTs, args.bars);
  let promotedApplied = false;
  let retestApplied = false;
  let highApplied = false;
  let decayApplied = false;

  if (args.promotedSignal && args.signal.terminalState === "CONFIRMED") {
    const next = clone(current);
    next.revision += 1;
    next.updatedAtMs = args.promotedSignal.signalTs;
      const promotedToFinal = args.promotedSignal.terminalState === "FINAL";
      next.lastRevisionReason = promotedToFinal ? "promoted_confirmed_to_final" : "promoted_confirmed_to_soft_final";
      next.setupState = next.tradabilityStatus === "not_tradable" ? "draft" : "active";
      next.entryMode = promotedToFinal && args.promotedSignal.finalTriggerEmitted && args.promotedSignal.totalScore >= 3.75
        ? "market_now"
        : "limit_on_retest";
      next.setupStyle = next.entryMode === "market_now" ? "aggressive" : promotedToFinal ? "standard" : "conservative";
      next.setupRationale = [...next.setupRationale, promotedToFinal
        ? "The setup matured from early confirmation into a cleaner short idea with more actionable timing."
        : "The setup matured into a soft-final short idea with enough confirmation to activate it, but still below hard-final confidence."
      ];
    const recalculated = recalcSetupGeometry({
      record: next,
      signal: args.promotedSignal,
      bars: args.bars.filter((bar) => bar.endMs <= args.promotedSignal!.signalTs).slice(-8),
      signalBar: findSignalBar(args.promotedSignal.signalTs, args.bars),
      ...(args.tuning ? { tuning: args.tuning } : {}),
    });
    const changedFields = summarizeChangedFields(current, recalculated);
    current = recalculated;
    revisions.push({
      id: `${args.runId}:setup-revision:${args.setupId}:${current.revision}`,
      runId: args.runId,
      setupId: args.setupId,
      signalId: args.signal.id,
      symbol: args.signal.symbol,
      revision: current.revision,
      ts: current.updatedAtMs,
        reasonCode: promotedToFinal ? "promoted_confirmed_to_final" : "promoted_confirmed_to_soft_final",
        changedFields,
        note: promotedToFinal ? "Draft setup promoted by later FINAL confirmation." : "Draft setup promoted by later SOFT_FINAL confirmation.",
        snapshot: clone(current),
      });
    promotedApplied = true;
    signalBar = findSignalBar(args.promotedSignal.signalTs, args.bars);
  }

  const lifecycleBars = args.bars
    .filter((bar) => bar.startMs > current.createdAtMs)
    .filter((bar) => bar.startMs <= current.setupExpiryTs)
    .sort((left, right) => left.startMs - right.startMs);

  for (const bar of lifecycleBars) {
    if (!retestApplied && current.entryZoneLow != null && current.entryZoneHigh != null && current.setupState !== "shadow") {
      const touchedZone = bar.high >= current.entryZoneLow && bar.low <= current.entryZoneHigh;
      if (touchedZone) {
        const next = clone(current);
        next.revision += 1;
        next.updatedAtMs = bar.endMs;
        next.lastRevisionReason = "retest_detected";
        if (next.entryMode === "limit_on_retest") {
          next.entryMode = "market_now";
          next.setupStyle = "aggressive";
        }
        next.setupRationale = [...next.setupRationale, "Price retested the short area, so the entry can be tightened around the refreshed rejection zone."];
        const recalculated = recalcSetupGeometry({
          record: next,
          signal: promotedApplied && args.promotedSignal ? args.promotedSignal : args.signal,
          bars: args.bars.filter((candidate) => candidate.endMs <= bar.endMs).slice(-8),
          signalBar: bar,
          ...(args.tuning ? { tuning: args.tuning } : {}),
        });
        const changedFields = summarizeChangedFields(current, recalculated);
        current = recalculated;
        revisions.push({
          id: `${args.runId}:setup-revision:${args.setupId}:${current.revision}`,
          runId: args.runId,
          setupId: args.setupId,
          signalId: args.signal.id,
          symbol: args.signal.symbol,
          revision: current.revision,
          ts: bar.endMs,
          reasonCode: "retest_detected",
          changedFields,
          note: "Price retested the active entry zone.",
          snapshot: clone(current),
        });
        retestApplied = true;
      }
    }

    if (!highApplied && current.anchors.setupHigh != null && current.invalidationPrice != null && bar.high > current.anchors.setupHigh && bar.high < current.invalidationPrice) {
      const next = clone(current);
      next.revision += 1;
      next.updatedAtMs = bar.endMs;
      next.lastRevisionReason = "new_local_high_before_invalidation";
      next.isWeakened = true;
      next.degradationReason = "new_local_high_before_invalidation";
      next.setupRationale = [...next.setupRationale, "Price pushed into a higher local high before the setup fully failed, which weakens the short and cheapens the reward relative to the risk."];
      const recalculated = recalcSetupGeometry({
        record: next,
        signal: promotedApplied && args.promotedSignal ? args.promotedSignal : args.signal,
        bars: args.bars.filter((candidate) => candidate.endMs <= bar.endMs).slice(-8),
        signalBar: bar,
        setupHighOverride: bar.high,
        decayPenalty: Math.max(next.confidenceBreakdown.decayPenalty, 0.12),
        ...(args.tuning ? { tuning: args.tuning } : {}),
      });
      const changedFields = summarizeChangedFields(current, recalculated);
      current = recalculated;
      revisions.push({
        id: `${args.runId}:setup-revision:${args.setupId}:${current.revision}`,
        runId: args.runId,
        setupId: args.setupId,
        signalId: args.signal.id,
        symbol: args.signal.symbol,
        revision: current.revision,
        ts: bar.endMs,
        reasonCode: "new_local_high_before_invalidation",
        changedFields,
        note: "New local high weakened the setup before invalidation was hit.",
        snapshot: clone(current),
      });
      highApplied = true;
    }

    if (!decayApplied) {
      const ttlMs = Math.max(ONE_MIN_MS, current.setupExpiryTs - current.createdAtMs);
      const elapsed = bar.endMs - current.createdAtMs;
      if (elapsed >= ttlMs * 0.5) {
        const next = clone(current);
        next.revision += 1;
        next.updatedAtMs = bar.endMs;
        next.lastRevisionReason = "time_decay_adjustment";
        next.setupRationale = [...next.setupRationale, "Time decay shifted the setup toward stricter entry quality requirements."];
        if (next.entryMode === "limit_on_retest") {
          next.entryMode = "confirmation_breakdown";
          next.setupStyle = "conservative";
        }
        const decayPenalty = elapsed >= ttlMs * 0.8 ? 0.4 : 0.2;
        const recalculated = recalcSetupGeometry({
          record: next,
          signal: promotedApplied && args.promotedSignal ? args.promotedSignal : args.signal,
          bars: args.bars.filter((candidate) => candidate.endMs <= bar.endMs).slice(-8),
          signalBar: bar,
          decayPenalty,
          ...(args.tuning ? { tuning: args.tuning } : {}),
        });
        if (elapsed >= ttlMs * 0.8 && recalculated.tradabilityStatus === "tradable") {
          recalculated.tradabilityStatus = "too_late";
          recalculated.isTradableNow = false;
        }
        const changedFields = summarizeChangedFields(current, recalculated);
        current = recalculated;
        revisions.push({
          id: `${args.runId}:setup-revision:${args.setupId}:${current.revision}`,
          runId: args.runId,
          setupId: args.setupId,
          signalId: args.signal.id,
          symbol: args.signal.symbol,
          revision: current.revision,
          ts: bar.endMs,
          reasonCode: "time_decay_adjustment",
          changedFields,
          note: "Setup decayed in time without a clean fill.",
          snapshot: clone(current),
        });
        decayApplied = true;
      }
    }
  }

  return {
    current,
    original: clone(base),
    revisions,
  };
}

function evaluateSetupAgainstBars(setup: ShortReplaySetupRecord, bars: ShortSignalMinuteBar[]): EvaluateOutcomeSummary {
  const futureBars = bars
    .filter((bar) => bar.endMs >= setup.createdAtMs)
    .filter((bar) => bar.startMs <= setup.setupExpiryTs);
  const entryTouchBar = futureBars.find((bar) => {
    if (setup.entryZoneLow == null || setup.entryZoneHigh == null) return false;
    return bar.high >= setup.entryZoneLow && bar.low <= setup.entryZoneHigh;
  }) ?? null;
  const didEnter = Boolean(entryTouchBar) && setup.tradabilityStatus !== "shadow" && setup.tradabilityStatus !== "not_tradable";
  const entryPrice = didEnter ? setup.entryPriceMid : null;
  const postEntryBars = didEnter && entryTouchBar
    ? futureBars.filter((bar) => bar.endMs >= entryTouchBar.endMs)
    : futureBars;
  const tp1Bar = didEnter && setup.target1Price != null ? postEntryBars.find((bar) => bar.low <= setup.target1Price!) ?? null : null;
  const tp2Bar = didEnter && setup.target2Price != null ? postEntryBars.find((bar) => bar.low <= setup.target2Price!) ?? null : null;
  const invalidationBar = didEnter && setup.invalidationPrice != null ? postEntryBars.find((bar) => bar.high >= setup.invalidationPrice!) ?? null : null;
  const expired = !tp1Bar && !tp2Bar && !invalidationBar && futureBars.length > 0;

  let bestLow = entryPrice ?? setup.setupReferencePrice ?? 0;
  let bestHigh = entryPrice ?? setup.setupReferencePrice ?? 0;
  for (const bar of postEntryBars) {
    bestLow = Math.min(bestLow, bar.low);
    bestHigh = Math.max(bestHigh, bar.high);
  }

  return {
    didEnter,
    entryTs: entryTouchBar?.startMs ?? null,
    entryPrice,
    didHitTp1: Boolean(tp1Bar) && (!invalidationBar || tp1Bar!.startMs <= invalidationBar.startMs) && setup.target1Price != null,
    didHitTp2: Boolean(tp2Bar) && (!invalidationBar || tp2Bar!.startMs <= invalidationBar.startMs) && setup.target2Price != null,
    didInvalidateFirst: Boolean(invalidationBar) && (!tp1Bar || invalidationBar!.startMs <= tp1Bar.startMs),
    invalidated: Boolean(invalidationBar),
    invalidationTs: invalidationBar?.startMs ?? null,
    invalidationPrice: invalidationBar && setup.invalidationPrice != null ? setup.invalidationPrice : null,
    tp1Ts: tp1Bar?.startMs ?? null,
    tp1Price: tp1Bar && setup.target1Price != null ? setup.target1Price : null,
    tp2Ts: tp2Bar?.startMs ?? null,
    tp2Price: tp2Bar && setup.target2Price != null ? setup.target2Price : null,
    expired,
    maxFavorableMove: didEnter && entryPrice && entryPrice > 0 ? (entryPrice - bestLow) / entryPrice : null,
    maxAdverseMove: didEnter && entryPrice && entryPrice > 0 ? (bestHigh - entryPrice) / entryPrice : null,
    bestRrAchieved: didEnter && entryPrice != null && setup.invalidationPrice != null
      ? ((entryPrice - bestLow) / Math.max(1e-8, setup.invalidationPrice - entryPrice))
      : null,
    timeToTp1Ms: tp1Bar && entryTouchBar ? tp1Bar.startMs - entryTouchBar.startMs : null,
    timeToTp2Ms: tp2Bar && entryTouchBar ? tp2Bar.startMs - entryTouchBar.startMs : null,
    timeToInvalidationMs: invalidationBar && entryTouchBar ? invalidationBar.startMs - entryTouchBar.startMs : null,
  };
}

export function buildShortSetupOutcomeRecord(args: {
  runId: string;
  setup: ShortReplaySetupRecord;
  originalSetup: ShortReplaySetupRecord;
  signal: ShortReplaySignalRecord | null;
  outcome: ShortSignalOutcomeRecord | null;
  bars: ShortSignalMinuteBar[];
}): ShortReplaySetupOutcomeRecord {
  const latest = evaluateSetupAgainstBars(args.setup, args.bars);
  const original = evaluateSetupAgainstBars(args.originalSetup, args.bars);
  return {
    id: `${args.runId}:setup-outcome:${args.setup.id}`,
    runId: args.runId,
    setupId: args.setup.id,
    signalId: args.setup.signalId,
    symbol: args.setup.symbol,
    entryMode: args.setup.entryMode,
    setupStateAtOpen: args.setup.setupState,
    didEnter: latest.didEnter,
    entryTs: latest.entryTs,
    entryPrice: latest.entryPrice,
    didHitTp1: latest.didHitTp1,
    didHitTp2: latest.didHitTp2,
    didInvalidateFirst: latest.didInvalidateFirst,
    invalidated: latest.invalidated,
    invalidationTs: latest.invalidationTs,
    invalidationPrice: latest.invalidationPrice,
    tp1Ts: latest.tp1Ts,
    tp1Price: latest.tp1Price,
    tp2Ts: latest.tp2Ts,
    tp2Price: latest.tp2Price,
    expired: latest.expired,
    expiryTs: args.setup.setupExpiryTs,
    maxFavorableMove: latest.maxFavorableMove,
    maxAdverseMove: latest.maxAdverseMove,
    bestRrAchieved: latest.bestRrAchieved,
    timeToTp1Ms: latest.timeToTp1Ms,
    timeToTp2Ms: latest.timeToTp2Ms,
    timeToInvalidationMs: latest.timeToInvalidationMs,
    signalRet15m: args.outcome?.ret15m ?? null,
    signalRet30m: args.outcome?.ret30m ?? null,
    original: {
      revision: args.originalSetup.revision,
      didEnter: original.didEnter,
      didHitTp1: original.didHitTp1,
      didHitTp2: original.didHitTp2,
      didInvalidateFirst: original.didInvalidateFirst,
      invalidated: original.invalidated,
      expired: original.expired,
      bestRrAchieved: original.bestRrAchieved,
    },
    createdAtMs: args.setup.createdAtMs,
    updatedAtMs: Date.now(),
  };
}
