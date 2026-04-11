import fs from "node:fs";
import path from "node:path";
import type {
  ShortLiveSetupDetail,
  ShortLiveSetupRecord,
  ShortReplaySetupRecord,
  ShortReplaySetupRevisionRecord,
  ShortReplaySetupTransitionRecord,
  ShortSetupRevisionReason,
  ShortSetupState,
  ShortSetupTradabilityStatus,
} from "../replay/shortReplayTypes.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RESTORABLE_STATES = new Set<ShortSetupState>(["draft", "active", "shadow"]);
const TRANSIENT_FS_ERROR_CODES = new Set(["UNKNOWN", "EBUSY", "EPERM", "EACCES"]);
const CURRENT_WRITE_MAX_ATTEMPTS = 4;
const CURRENT_WRITE_RETRY_MS = 25;

type SyncLiveSetupLifecycleArgs = {
  setup: ShortReplaySetupRecord;
  revisions: ShortReplaySetupRevisionRecord[];
  signalState: "CANDIDATE" | "CONFIRMED" | "SOFT_FINAL" | "FINAL" | "SUPPRESSED";
};

type ListLiveSetupArgs = {
  symbol?: string | null | undefined;
  setupState?: string | null | undefined;
  tradabilityStatus?: string | null | undefined;
  dateFromTs?: number | null | undefined;
  dateToTs?: number | null | undefined;
  limit?: number | null | undefined;
};

function normalizeSymbol(symbolRaw: string): string {
  return String(symbolRaw ?? "").trim().toUpperCase();
}

function floorUtcDay(tsMs: number): number {
  const date = new Date(tsMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function toUtcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // ignore malformed rows
    }
  }
  return out;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientFsWriteError(error: unknown): boolean {
  const code = String((error as { code?: string } | null | undefined)?.code ?? "").trim().toUpperCase();
  return TRANSIENT_FS_ERROR_CODES.has(code);
}

function toLatestRevisionSummary(revision: ShortReplaySetupRevisionRecord | null | undefined): ShortLiveSetupRecord["latestRevisionSummary"] {
  if (!revision) return null;
  return {
    revision: revision.revision,
    ts: revision.ts,
    reasonCode: revision.reasonCode,
    changedFields: [...revision.changedFields],
    note: revision.note ?? null,
  };
}

function toLiveRecord(
  setup: ShortReplaySetupRecord,
  extras: {
    current: boolean;
    restoredFromDisk: boolean;
    lastSignalState: "CANDIDATE" | "CONFIRMED" | "SOFT_FINAL" | "FINAL" | "SUPPRESSED" | null;
    latestRevisionSummary: ShortLiveSetupRecord["latestRevisionSummary"];
  },
): ShortLiveSetupRecord {
  return {
    ...setup,
    liveSetupId: setup.id,
    current: extras.current,
    restoredFromDisk: extras.restoredFromDisk,
    lastSignalState: extras.lastSignalState,
    latestRevisionSummary: extras.latestRevisionSummary,
  };
}

function toReplayRecord(record: ShortLiveSetupRecord): ShortReplaySetupRecord {
  return {
    id: record.id,
    runId: record.runId,
    signalId: record.signalId,
    symbol: record.symbol,
    sourceSignalState: record.sourceSignalState,
    setupState: record.setupState,
    tradabilityStatus: record.tradabilityStatus,
    setupType: record.setupType,
    setupStyle: record.setupStyle,
    entryMode: record.entryMode,
    entryZoneLow: record.entryZoneLow,
    entryZoneHigh: record.entryZoneHigh,
    entryPriceMid: record.entryPriceMid,
    setupReferencePrice: record.setupReferencePrice,
    invalidationPrice: record.invalidationPrice,
    invalidationPctFromReference: record.invalidationPctFromReference,
    invalidationType: record.invalidationType,
    target1Price: record.target1Price,
    target2Price: record.target2Price,
    rrToTp1: record.rrToTp1,
    rrToTp2: record.rrToTp2,
    expectedRr: record.expectedRr,
    setupQualityScore: record.setupQualityScore,
    confidence: record.confidence,
    reasons: [...record.reasons],
    setupRationale: [...record.setupRationale],
    whyTradableSummary: record.whyTradableSummary,
    lastRevisionReason: record.lastRevisionReason,
    isWeakened: record.isWeakened,
    degradationReason: record.degradationReason,
    confidenceBreakdown: { ...record.confidenceBreakdown },
    anchors: { ...record.anchors },
    isTradableNow: record.isTradableNow,
    supersedesSetupId: record.supersedesSetupId,
    supersededBySetupId: record.supersededBySetupId,
    setupExpiryTs: record.setupExpiryTs,
    revision: record.revision,
    setupVersion: record.setupVersion,
    setupRulesVersion: record.setupRulesVersion,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    outcomeId: record.outcomeId,
  };
}

export class ShortLiveSetupStore {
  private readonly rootDir: string;
  private readonly currentPath: string;
  private readonly revisionsDir: string;
  private readonly transitionsDir: string;
  private loaded = false;
  private readonly currentById = new Map<string, ShortLiveSetupRecord>();
  private readonly currentSetupIdBySymbol = new Map<string, string>();

  constructor(rootDir = path.resolve(process.cwd(), "data", "short_live_setups")) {
    this.rootDir = rootDir;
    this.currentPath = path.join(rootDir, "current.json");
    this.revisionsDir = path.join(rootDir, "revisions");
    this.transitionsDir = path.join(rootDir, "transitions");
    this.ensureLoaded();
  }

  listCurrent(args: ListLiveSetupArgs = {}): ShortLiveSetupRecord[] {
    this.ensureLoaded();
    return this.filterRecords(Array.from(this.currentById.values()), args);
  }

  listHistory(args: ListLiveSetupArgs = {}): ShortLiveSetupRecord[] {
    this.ensureLoaded();
    const byId = new Map<string, ShortLiveSetupRecord>();
    for (const record of this.currentById.values()) {
      byId.set(record.liveSetupId, record);
    }
    for (const revision of this.readRevisionHistory(args)) {
      const current = byId.get(revision.setupId);
      if (current && current.revision >= revision.revision) continue;
      byId.set(revision.setupId, toLiveRecord(revision.snapshot, {
        current: false,
        restoredFromDisk: false,
        lastSignalState: revision.snapshot.sourceSignalState,
        latestRevisionSummary: toLatestRevisionSummary(revision),
      }));
    }
    return this.filterRecords(Array.from(byId.values()), args);
  }

  readDetail(liveSetupId: string): ShortLiveSetupDetail {
    this.ensureLoaded();
    const normalizedId = String(liveSetupId ?? "").trim();
    const revisions = this.readAllRevisions()
      .filter((row) => row.setupId === normalizedId)
      .sort((left, right) => left.revision - right.revision || left.ts - right.ts);
    const transitions = this.readAllTransitions()
      .filter((row) => row.setupId === normalizedId)
      .sort((left, right) => left.ts - right.ts || left.revision - right.revision);
    const current = this.currentById.get(normalizedId) ?? null;
    const record = current ?? (revisions.length
      ? toLiveRecord(revisions[revisions.length - 1]!.snapshot, {
          current: false,
          restoredFromDisk: false,
          lastSignalState: revisions[revisions.length - 1]!.snapshot.sourceSignalState,
          latestRevisionSummary: toLatestRevisionSummary(revisions[revisions.length - 1]),
        })
      : null);
    return { record, revisions, transitions };
  }

  syncLifecycle(args: SyncLiveSetupLifecycleArgs): {
    record: ShortLiveSetupRecord;
    latestRevision: ShortReplaySetupRevisionRecord | null;
  } {
    this.ensureLoaded();
    this.reconcileExpiry(args.setup.updatedAtMs);
    const symbol = normalizeSymbol(args.setup.symbol);
    const previousIdForSymbol = this.currentSetupIdBySymbol.get(symbol) ?? null;
    if (previousIdForSymbol && previousIdForSymbol !== args.setup.id) {
      this.supersedeCurrent(previousIdForSymbol, args.setup.id, args.setup.updatedAtMs);
    }

    const previous = this.currentById.get(args.setup.id) ?? null;
    const previousRevision = previous?.revision ?? 0;
    const missingRevisions = args.revisions
      .filter((revision) => revision.revision > previousRevision)
      .sort((left, right) => left.revision - right.revision);
    let priorSnapshot = previous ? toReplayRecord(previous) : null;
    for (const revision of missingRevisions) {
      this.appendRevision(revision);
      this.appendTransition(this.buildTransition(revision, priorSnapshot?.setupState ?? null));
      priorSnapshot = revision.snapshot;
    }

    const latestRevision = missingRevisions[missingRevisions.length - 1]
      ?? (previous?.latestRevisionSummary
        ? {
            id: `${args.setup.runId}:setup-revision:${args.setup.id}:${previous.latestRevisionSummary.revision}`,
            runId: args.setup.runId,
            setupId: args.setup.id,
            signalId: args.setup.signalId,
            symbol,
            revision: previous.latestRevisionSummary.revision,
            ts: previous.latestRevisionSummary.ts,
            reasonCode: previous.latestRevisionSummary.reasonCode,
            changedFields: [...previous.latestRevisionSummary.changedFields],
            note: previous.latestRevisionSummary.note,
            snapshot: args.setup,
          } satisfies ShortReplaySetupRevisionRecord
        : null);

    const nextRecord = toLiveRecord(args.setup, {
      current: true,
      restoredFromDisk: false,
      lastSignalState: args.signalState,
      latestRevisionSummary: toLatestRevisionSummary(latestRevision),
    });
    const existing = this.currentById.get(nextRecord.liveSetupId) ?? null;
    if (!existing || !sameJson(existing, nextRecord)) {
      this.currentById.set(nextRecord.liveSetupId, nextRecord);
      this.currentSetupIdBySymbol.set(symbol, nextRecord.liveSetupId);
      this.persistCurrent();
    }
    return {
      record: this.currentById.get(nextRecord.liveSetupId) ?? nextRecord,
      latestRevision: missingRevisions[missingRevisions.length - 1] ?? null,
    };
  }

  reconcileExpiry(nowMs: number): void {
    this.ensureLoaded();
    let dirty = false;
    for (const current of Array.from(this.currentById.values())) {
      if (!RESTORABLE_STATES.has(current.setupState)) continue;
      if (!(current.setupExpiryTs > 0) || nowMs < current.setupExpiryTs) continue;
      const next = {
        ...toReplayRecord(current),
        setupState: "expired" as const,
        tradabilityStatus: current.tradabilityStatus === "shadow" ? "shadow" as const : "not_tradable" as const,
        isTradableNow: false,
        updatedAtMs: nowMs,
        revision: current.revision + 1,
        lastRevisionReason: "expired" as const,
        whyTradableSummary: "Live setup expired before receiving a fresh short trigger.",
      };
      const revision: ShortReplaySetupRevisionRecord = {
        id: `live:setup-revision:${current.liveSetupId}:${next.revision}`,
        runId: "live",
        setupId: current.liveSetupId,
        signalId: current.signalId,
        symbol: current.symbol,
        revision: next.revision,
        ts: nowMs,
        reasonCode: "expired",
        changedFields: ["setupState", "tradabilityStatus", "isTradableNow"],
        note: "TTL reached in live tracking.",
        snapshot: next,
      };
      this.appendRevision(revision);
      this.appendTransition(this.buildTransition(revision, current.setupState));
      this.currentById.delete(current.liveSetupId);
      if (this.currentSetupIdBySymbol.get(normalizeSymbol(current.symbol)) === current.liveSetupId) {
        this.currentSetupIdBySymbol.delete(normalizeSymbol(current.symbol));
      }
      dirty = true;
    }
    if (dirty) this.persistCurrent();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const payload = readJson<{ records?: ShortLiveSetupRecord[] }>(this.currentPath, {});
    for (const raw of payload.records ?? []) {
      if (!raw || !raw.liveSetupId || !RESTORABLE_STATES.has(raw.setupState)) continue;
      const restored = {
        ...raw,
        current: true,
        restoredFromDisk: true,
      } satisfies ShortLiveSetupRecord;
      this.currentById.set(restored.liveSetupId, restored);
      this.currentSetupIdBySymbol.set(normalizeSymbol(restored.symbol), restored.liveSetupId);
    }
    this.loaded = true;
  }

  private filterRecords(records: ShortLiveSetupRecord[], args: ListLiveSetupArgs): ShortLiveSetupRecord[] {
    const symbol = normalizeSymbol(String(args.symbol ?? ""));
    const setupState = String(args.setupState ?? "").trim();
    const tradabilityStatus = String(args.tradabilityStatus ?? "").trim();
    const dateFromTs = Number.isFinite(Number(args.dateFromTs)) ? Number(args.dateFromTs) : null;
    const dateToTs = Number.isFinite(Number(args.dateToTs)) ? Number(args.dateToTs) : null;
    const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 200;
    return records
      .filter((record) => !symbol || normalizeSymbol(record.symbol) === symbol)
      .filter((record) => !setupState || record.setupState === setupState)
      .filter((record) => !tradabilityStatus || record.tradabilityStatus === tradabilityStatus)
      .filter((record) => dateFromTs == null || record.updatedAtMs >= dateFromTs)
      .filter((record) => dateToTs == null || record.updatedAtMs <= dateToTs)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.symbol.localeCompare(right.symbol))
      .slice(0, limit);
  }

  private supersedeCurrent(previousSetupId: string, nextSetupId: string, ts: number): void {
    const previous = this.currentById.get(previousSetupId);
    if (!previous || previous.supersededBySetupId === nextSetupId) return;
    const nextSnapshot: ShortReplaySetupRecord = {
      ...toReplayRecord(previous),
      setupState: "cancelled",
      tradabilityStatus: previous.tradabilityStatus === "shadow" ? "shadow" : "not_tradable",
      isTradableNow: false,
      supersededBySetupId: nextSetupId,
      updatedAtMs: ts,
      revision: previous.revision + 1,
      lastRevisionReason: "superseded",
      whyTradableSummary: `Superseded by newer live setup ${nextSetupId}.`,
    };
    const revision: ShortReplaySetupRevisionRecord = {
      id: `live:setup-revision:${previousSetupId}:${nextSnapshot.revision}`,
      runId: "live",
      setupId: previousSetupId,
      signalId: previous.signalId,
      symbol: previous.symbol,
      revision: nextSnapshot.revision,
      ts,
      reasonCode: "superseded",
      changedFields: ["setupState", "tradabilityStatus", "isTradableNow", "supersededBySetupId"],
      note: "Newer live setup superseded this chain.",
      snapshot: nextSnapshot,
    };
    this.appendRevision(revision);
    this.appendTransition(this.buildTransition(revision, previous.setupState));
    this.currentById.delete(previousSetupId);
    if (this.currentSetupIdBySymbol.get(normalizeSymbol(previous.symbol)) === previousSetupId) {
      this.currentSetupIdBySymbol.delete(normalizeSymbol(previous.symbol));
    }
    this.persistCurrent();
  }

  private buildTransition(
    revision: ShortReplaySetupRevisionRecord,
    prevState: ShortSetupState | null,
  ): ShortReplaySetupTransitionRecord {
    return {
      id: `live:setup-transition:${revision.setupId}:${revision.revision}`,
      runId: "live",
      setupId: revision.setupId,
      signalId: revision.signalId,
      symbol: revision.symbol,
      ts: revision.ts,
      prevState,
      nextState: revision.snapshot.setupState,
      revision: revision.revision,
      reasonCode: revision.reasonCode,
      note: revision.note ?? null,
    };
  }

  private appendRevision(revision: ShortReplaySetupRevisionRecord): void {
    const filePath = path.join(this.revisionsDir, `${toUtcDayKey(revision.ts)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(revision)}\n`, "utf8");
  }

  private appendTransition(transition: ShortReplaySetupTransitionRecord): void {
    const filePath = path.join(this.transitionsDir, `${toUtcDayKey(transition.ts)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(transition)}\n`, "utf8");
  }

  private persistCurrent(): void {
    fs.mkdirSync(path.dirname(this.currentPath), { recursive: true });
    const payload = JSON.stringify({
      updatedAtMs: Date.now(),
      records: Array.from(this.currentById.values())
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.symbol.localeCompare(right.symbol)),
    }, null, 2);
    for (let attempt = 1; attempt <= CURRENT_WRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        fs.writeFileSync(this.currentPath, payload, "utf8");
        return;
      } catch (error) {
        if (!isTransientFsWriteError(error) || attempt >= CURRENT_WRITE_MAX_ATTEMPTS) {
          console.warn(`[short-live-setups] current persist skipped: ${String((error as Error | null | undefined)?.message ?? error)}`);
          return;
        }
        sleepSync(CURRENT_WRITE_RETRY_MS);
      }
    }
  }

  private readRevisionHistory(args: ListLiveSetupArgs): ShortReplaySetupRevisionRecord[] {
    const dateFromTs = Number.isFinite(Number(args.dateFromTs)) ? Number(args.dateFromTs) : null;
    const dateToTs = Number.isFinite(Number(args.dateToTs)) ? Number(args.dateToTs) : null;
    const files = this.listDayFiles(this.revisionsDir, dateFromTs, dateToTs);
    const symbol = normalizeSymbol(String(args.symbol ?? ""));
    const out: ShortReplaySetupRevisionRecord[] = [];
    for (const filePath of files) {
      out.push(
        ...readJsonlFile<ShortReplaySetupRevisionRecord>(filePath)
          .filter((row) => !symbol || normalizeSymbol(row.symbol) === symbol),
      );
    }
    return out;
  }

  private readAllRevisions(): ShortReplaySetupRevisionRecord[] {
    const out: ShortReplaySetupRevisionRecord[] = [];
    for (const filePath of this.listDayFiles(this.revisionsDir, null, null)) {
      out.push(...readJsonlFile<ShortReplaySetupRevisionRecord>(filePath));
    }
    return out;
  }

  private readAllTransitions(): ShortReplaySetupTransitionRecord[] {
    const out: ShortReplaySetupTransitionRecord[] = [];
    for (const filePath of this.listDayFiles(this.transitionsDir, null, null)) {
      out.push(...readJsonlFile<ShortReplaySetupTransitionRecord>(filePath));
    }
    return out;
  }

  private listDayFiles(dirPath: string, startMs: number | null, endMs: number | null): string[] {
    if (!fs.existsSync(dirPath)) return [];
    const files = fs.readdirSync(dirPath)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, filePath: path.join(dirPath, name) }))
      .filter(({ name }) => {
        const ts = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
        if (!Number.isFinite(ts)) return false;
        if (startMs != null && ts + ONE_DAY_MS < floorUtcDay(startMs)) return false;
        if (endMs != null && ts > floorUtcDay(endMs)) return false;
        return true;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return files.map((item) => item.filePath);
  }
}

export const shortLiveSetupStore = new ShortLiveSetupStore();
