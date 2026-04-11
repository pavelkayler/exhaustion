import fs from "node:fs";
import path from "node:path";
import { normalizeBybitKlineInterval, type BybitKlineInterval } from "./datasetTargetStore.js";

export type DatasetHistoryRecord = {
  id: string; // Receive Data jobId
  paramsKey: string; // tracked stream identity key
  streamKey?: string;
  rangePreset?: string;
  universeId: string;
  universeName: string;

  startMs: number;
  endMs: number;
  interval: BybitKlineInterval;

  receivedAtMs: number;
  lastUpdateAtMs: number;

  receivedSymbols: string[];
  receivedSymbolsCount: number;
  hasOi: boolean;
  hasFunding: boolean;

  // Count of optimizer LOOP starts that included this history id
  loopsCount: number;

  manifest?: DatasetHistoryManifestSummary;
};

export type DatasetHistoryManifestSummary = {
  status: "ok" | "partial" | "bad";
  updatedAt: number;
  coveragePct: number;
  missing1mCandlesTotal: number;
  missingOi5mPointsTotal: number;
  missingFundingPointsTotal: number;
  duplicatesTotal: number;
  outOfOrderTotal: number;
};

const HISTORY_ROOT = path.resolve(process.cwd(), "data", "history");
const INDEX_PATH = path.join(HISTORY_ROOT, "index.json");
const MANIFEST_ROOT = path.resolve(process.cwd(), "data", "cache", "manifests");

function readUniverseSymbolsSafe(universeId: string): string[] {
  void universeId;
  return [];
}

function normalizeHistoryInterval(input: unknown): BybitKlineInterval {
  const normalized = normalizeBybitKlineInterval(input);
  return normalized === "1" ? "5" : normalized;
}

function ensureRoot() {
  fs.mkdirSync(HISTORY_ROOT, { recursive: true });
}

function safeId(id: string): string {
  const v = String(id ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(v)) throw new Error("invalid_history_id");
  return v;
}

function recordDir(id: string): string {
  ensureRoot();
  return path.join(HISTORY_ROOT, safeId(id));
}

function metaPath(id: string): string {
  return path.join(recordDir(id), "meta.json");
}

function readIndex(): DatasetHistoryRecord[] {
  ensureRoot();
  if (!fs.existsSync(INDEX_PATH)) return [];
  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: DatasetHistoryRecord[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const it: any = item;
      const id = String(it.id ?? "").trim();
      const universeId = String(it.universeId ?? "").trim();
      const universeName = String(it.universeName ?? "").trim();
      const startMs = Number(it.startMs);
      const endMs = Number(it.endMs);
      const receivedAtMs = Number(it.receivedAtMs);
      const interval = normalizeHistoryInterval(it.interval);
      const lastUpdateAtMs = Number.isFinite(Number(it.lastUpdateAtMs)) ? Number(it.lastUpdateAtMs) : receivedAtMs;
      const streamKeyRaw = typeof it.streamKey === "string" ? it.streamKey.trim() : "";
      const rangePresetRaw = typeof it.rangePreset === "string" ? it.rangePreset.trim() : "";
      const paramsKey = streamKeyRaw || `${universeId}|${startMs}|${endMs}|${interval}`;
      const rawReceivedSymbols = Array.isArray(it.receivedSymbols)
        ? it.receivedSymbols.filter((s: any) => typeof s === "string" && s.trim())
        : [];
      const receivedSymbols = rawReceivedSymbols.length > 0 ? rawReceivedSymbols : readUniverseSymbolsSafe(universeId);
      const receivedSymbolsCount = Math.max(0, Math.floor(Number(it.receivedSymbolsCount) || receivedSymbols.length));
      const hasOi = Boolean(it.hasOi);
      const hasFunding = Boolean(it.hasFunding);
      const loopsCount = Math.max(0, Math.floor(Number(it.loopsCount) || 0));
      const manifest = normalizeManifestSummary(it.manifest);
      if (!id || !universeId || !universeName) continue;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(receivedAtMs) || !Number.isFinite(lastUpdateAtMs)) continue;
      out.push({
        id,
        paramsKey,
        ...(streamKeyRaw ? { streamKey: streamKeyRaw } : {}),
        ...(rangePresetRaw ? { rangePreset: rangePresetRaw } : {}),
        universeId,
        universeName,
        startMs,
        endMs,
        interval,
        receivedAtMs,
        lastUpdateAtMs,
        receivedSymbols,
        receivedSymbolsCount,
        hasOi,
        hasFunding,
        loopsCount,
        ...(manifest ? { manifest } : {}),
      });
    }
    out.sort((a, b) => b.lastUpdateAtMs - a.lastUpdateAtMs);
    return out;
  } catch {
    return [];
  }
}

function writeIndex(items: DatasetHistoryRecord[]) {
  ensureRoot();
  const sorted = [...items].sort((a, b) => b.lastUpdateAtMs - a.lastUpdateAtMs);
  fs.writeFileSync(INDEX_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

function rmDirBestEffort(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function normalizeManifestSummary(raw: unknown): DatasetHistoryManifestSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const status = String(value.status ?? "").trim();
  if (status !== "ok" && status !== "partial" && status !== "bad") return undefined;
  const updatedAt = Math.max(0, Math.floor(Number(value.updatedAt) || 0));
  const coveragePct = Number(value.coveragePct);
  if (updatedAt <= 0 || !Number.isFinite(coveragePct)) return undefined;
  return {
    status,
    updatedAt,
    coveragePct,
    missing1mCandlesTotal: Math.max(0, Math.floor(Number(value.missing1mCandlesTotal) || 0)),
    missingOi5mPointsTotal: Math.max(0, Math.floor(Number(value.missingOi5mPointsTotal) || 0)),
    missingFundingPointsTotal: Math.max(0, Math.floor(Number(value.missingFundingPointsTotal) || 0)),
    duplicatesTotal: Math.max(0, Math.floor(Number(value.duplicatesTotal) || 0)),
    outOfOrderTotal: Math.max(0, Math.floor(Number(value.outOfOrderTotal) || 0)),
  };
}

export function listDatasetHistories(): DatasetHistoryRecord[] {
  return readIndex();
}

export function findDatasetHistoryByStreamKey(streamKey: string): DatasetHistoryRecord | null {
  const key = String(streamKey ?? "").trim();
  if (!key) return null;
  const found = readIndex().find((row) => row.streamKey === key || row.paramsKey === key);
  return found ?? null;
}

export function readDatasetHistory(id: string): DatasetHistoryRecord {
  const safe = safeId(id);
  const fp = metaPath(safe);
  if (!fs.existsSync(fp)) throw new Error("history_not_found");
  const raw = fs.readFileSync(fp, "utf8");
  const parsed = JSON.parse(raw) as DatasetHistoryRecord;
  if (!parsed?.id || !parsed?.universeId) throw new Error("invalid_history_file");
  const manifest = normalizeManifestSummary((parsed as any).manifest);
  const normalizedReceivedSymbols = (() => {
    const symbols = Array.isArray(parsed.receivedSymbols)
      ? parsed.receivedSymbols.filter((s) => typeof s === "string" && s.trim())
      : [];
    return symbols.length > 0 ? symbols : readUniverseSymbolsSafe(String(parsed.universeId));
  })();
  const normalized: DatasetHistoryRecord = {
    id: String(parsed.id),
    paramsKey: (typeof (parsed as any)?.streamKey === "string" && (parsed as any).streamKey.trim())
      ? String((parsed as any).streamKey).trim()
      : `${parsed.universeId}|${parsed.startMs}|${parsed.endMs}|${normalizeHistoryInterval((parsed as any).interval)}`,
    ...((typeof (parsed as any)?.streamKey === "string" && (parsed as any).streamKey.trim())
      ? { streamKey: String((parsed as any).streamKey).trim() }
      : {}),
    ...((typeof (parsed as any)?.rangePreset === "string" && (parsed as any).rangePreset.trim())
      ? { rangePreset: String((parsed as any).rangePreset).trim() }
      : {}),
    universeId: String(parsed.universeId),
    universeName: String(parsed.universeName),
    startMs: Number(parsed.startMs),
    endMs: Number(parsed.endMs),
    interval: normalizeHistoryInterval((parsed as any).interval),
    receivedAtMs: Number(parsed.receivedAtMs),
    lastUpdateAtMs: Number((parsed as any).lastUpdateAtMs ?? parsed.receivedAtMs),
    receivedSymbols: normalizedReceivedSymbols,
    receivedSymbolsCount: Math.max(
      0,
      Math.floor(
        Number(parsed.receivedSymbolsCount) || normalizedReceivedSymbols.length,
      ),
    ),
    hasOi: Boolean((parsed as any).hasOi),
    hasFunding: Boolean((parsed as any).hasFunding),
    loopsCount: Math.max(0, Math.floor(Number(parsed.loopsCount) || 0)),
    ...(manifest ? { manifest } : {}),
  };
  return normalized;
}

export function upsertLatestDatasetHistory(input: {
  id: string;
  universeId: string;
  universeName: string;
  startMs: number;
  endMs: number;
  interval: BybitKlineInterval;
  receivedAtMs: number;
  lastUpdateAtMs?: number;
  receivedSymbols: string[];
  hasOi: boolean;
  hasFunding: boolean;
  manifest?: DatasetHistoryManifestSummary;
  streamKey?: string;
  rangePreset?: string;
  mergeIntoId?: string;
}): DatasetHistoryRecord {
  let id = safeId(input.id);
  const universeId = String(input.universeId ?? "").trim();
  const universeName = String(input.universeName ?? "").trim();
  const startMs = Number(input.startMs);
  const endMs = Number(input.endMs);
  const interval = normalizeHistoryInterval(input.interval);
  const receivedAtMs = Number(input.receivedAtMs);
  const lastUpdateAtMs = Number.isFinite(Number(input.lastUpdateAtMs))
    ? Number(input.lastUpdateAtMs)
    : receivedAtMs;
  const receivedSymbols = Array.isArray(input.receivedSymbols)
    ? input.receivedSymbols.filter((s) => typeof s === "string" && s.trim())
    : [];
  const hasOi = Boolean(input.hasOi);
  const hasFunding = Boolean(input.hasFunding);
  const manifest = normalizeManifestSummary(input.manifest);
  if (!universeId || !universeName) throw new Error("invalid_history_input");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(receivedAtMs) || !Number.isFinite(lastUpdateAtMs)) {
    throw new Error("invalid_history_input");
  }

  const streamKey = typeof input.streamKey === "string" ? input.streamKey.trim() : "";
  const rangePreset = typeof input.rangePreset === "string" ? input.rangePreset.trim() : "";
  const mergeIntoId = typeof input.mergeIntoId === "string" ? input.mergeIntoId.trim() : "";
  const paramsKey = streamKey || `${universeId}|${startMs}|${endMs}|${interval}`;

  const items = readIndex();
  let carryLoops = 0;
  let stableReceivedAtMs = receivedAtMs;
  let stableStartMs = startMs;
  let stableEndMs = endMs;
  let stableReceivedSymbols = receivedSymbols.slice();
  let stableHasOi = hasOi;
  let stableHasFunding = hasFunding;

  const mergedPrev: DatasetHistoryRecord[] = [];
  if (mergeIntoId) {
    const mergeIdx = items.findIndex((row) => row.id === mergeIntoId);
    if (mergeIdx >= 0) mergedPrev.push(items.splice(mergeIdx, 1)[0]!);
  }
  while (true) {
    const prevIdx = items.findIndex((row) => row.paramsKey === paramsKey);
    if (prevIdx < 0) break;
    mergedPrev.push(items.splice(prevIdx, 1)[0]!);
  }
  if (mergedPrev.length > 0) {
    const preferred = mergedPrev.find((row) => row.id === mergeIntoId) ?? mergedPrev[0]!;
    id = preferred.id;
    for (const prev of mergedPrev) {
      carryLoops = Math.max(carryLoops, Math.floor(prev.loopsCount || 0));
      const prevReceivedAtMs = Number(prev.receivedAtMs);
      if (Number.isFinite(prevReceivedAtMs) && prevReceivedAtMs > 0) {
        stableReceivedAtMs = Math.min(stableReceivedAtMs, prevReceivedAtMs);
      }
      const prevStartMs = Number(prev.startMs);
      if (Number.isFinite(prevStartMs) && prevStartMs > 0) {
        stableStartMs = Math.min(stableStartMs, prevStartMs);
      }
      const prevEndMs = Number(prev.endMs);
      if (Number.isFinite(prevEndMs) && prevEndMs > 0) {
        stableEndMs = Math.max(stableEndMs, prevEndMs);
      }
      if (stableReceivedSymbols.length === 0 && Array.isArray(prev.receivedSymbols) && prev.receivedSymbols.length > 0) {
        stableReceivedSymbols = prev.receivedSymbols.filter((s) => typeof s === "string" && s.trim());
      }
      if (!stableHasOi && Boolean(prev.hasOi)) stableHasOi = true;
      if (!stableHasFunding && Boolean(prev.hasFunding)) stableHasFunding = true;
      if (prev.id !== id) {
        rmDirBestEffort(recordDir(prev.id));
      }
    }
  }

  const record: DatasetHistoryRecord = {
    id,
    paramsKey,
    ...(streamKey ? { streamKey } : {}),
    ...(rangePreset ? { rangePreset } : {}),
    universeId,
    universeName,
    startMs: stableStartMs,
    endMs: stableEndMs,
    interval,
    receivedAtMs: stableReceivedAtMs,
    lastUpdateAtMs,
    receivedSymbols: stableReceivedSymbols,
    receivedSymbolsCount: stableReceivedSymbols.length,
    hasOi: stableHasOi,
    hasFunding: stableHasFunding,
    loopsCount: carryLoops,
    ...(manifest ? { manifest } : {}),
  };

  fs.mkdirSync(recordDir(id), { recursive: true });
  fs.writeFileSync(metaPath(id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  items.unshift(record);
  writeIndex(items);
  return record;
}

export function deleteDatasetHistory(id: string) {
  const safe = safeId(id);
  const items = readIndex().filter((r) => r.id !== safe);
  writeIndex(items);
  rmDirBestEffort(recordDir(safe));
  try {
    fs.rmSync(path.join(MANIFEST_ROOT, `${safe}.json`), { force: true });
  } catch {
    // ignore
  }
}

export function setDatasetHistoryManifestSummary(id: string, summary: DatasetHistoryManifestSummary) {
  const safe = safeId(id);
  const normalized = normalizeManifestSummary(summary);
  if (!normalized) throw new Error("invalid_manifest_summary");
  const items = readIndex();
  const idx = items.findIndex((row) => row.id === safe);
  if (idx < 0) throw new Error("history_not_found");
  const current = items[idx];
  if (!current) throw new Error("history_not_found");
  const next: DatasetHistoryRecord = { ...current, manifest: normalized };
  items[idx] = next;
  writeIndex(items);
  fs.mkdirSync(recordDir(safe), { recursive: true });
  fs.writeFileSync(metaPath(safe), `${JSON.stringify(items[idx], null, 2)}\n`, "utf8");
}

export function incrementDatasetHistoryLoops(ids: string[], delta: number) {
  const d = Math.max(0, Math.floor(Number(delta) || 0));
  if (d <= 0) return;

  const set = new Set((Array.isArray(ids) ? ids : []).map((v) => String(v ?? "").trim()).filter(Boolean));
  if (!set.size) return;

  const items = readIndex();
  let changed = false;
  for (const rec of items) {
    if (!set.has(rec.id)) continue;
    rec.loopsCount = Math.max(0, Math.floor(rec.loopsCount || 0) + d);
    changed = true;
    try {
      fs.writeFileSync(metaPath(rec.id), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
    } catch {
      // ignore
    }
  }
  if (changed) writeIndex(items);
}

export function touchDatasetHistoryTail(id: string, endMs: number, lastUpdateAtMs = Date.now()): DatasetHistoryRecord | null {
  const safe = safeId(id);
  const nextEndMs = Math.floor(Number(endMs) || 0);
  const nextUpdateAtMs = Math.floor(Number(lastUpdateAtMs) || Date.now());
  if (!Number.isFinite(nextEndMs) || nextEndMs <= 0 || !Number.isFinite(nextUpdateAtMs) || nextUpdateAtMs <= 0) {
    return null;
  }
  const items = readIndex();
  const idx = items.findIndex((row) => row.id === safe);
  if (idx < 0) return null;
  const current = items[idx];
  if (!current) return null;
  if (nextEndMs <= current.endMs && nextUpdateAtMs <= current.lastUpdateAtMs) return current;
  const updated: DatasetHistoryRecord = {
    ...current,
    endMs: Math.max(current.endMs, nextEndMs),
    lastUpdateAtMs: Math.max(current.lastUpdateAtMs, nextUpdateAtMs),
  };
  items[idx] = updated;
  writeIndex(items);
  fs.mkdirSync(recordDir(safe), { recursive: true });
  fs.writeFileSync(metaPath(safe), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}
