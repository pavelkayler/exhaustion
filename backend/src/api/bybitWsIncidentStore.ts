import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDirPath } from "../utils/diskGuard.js";

export type BybitWsIncidentType =
  | "failure"
  | "reconnect_scheduled"
  | "recovered"
  | "stale_guard_skipped";

export type BybitWsIncidentRecord = {
  id: string;
  ts: number;
  type: BybitWsIncidentType;
  reason: string;
  shardKey: string | null;
  staleMs: number | null;
  attempt: number | null;
  recoveredAt: number | null;
  delayMs: number | null;
  topics: number | null;
  eventLoopLagMs: number | null;
  fullReconnect: boolean;
};

const MAX_RECENT_INCIDENTS = 200;

const recentIncidents: BybitWsIncidentRecord[] = [];
let hydrated = false;

function getCanonicalBybitWsIncidentsPath() {
  return path.resolve(getDataDirPath(), "incidents", "bybit_ws_incidents.jsonl");
}

function getLegacyBybitWsIncidentsPath() {
  return path.resolve(process.cwd(), "backend", "data", "incidents", "bybit_ws_incidents.jsonl");
}

function getBybitWsIncidentsPathInternal() {
  return getCanonicalBybitWsIncidentsPath();
}

function ensureIncidentDir() {
  fs.mkdirSync(path.dirname(getBybitWsIncidentsPathInternal()), { recursive: true });
}

function migrateLegacyIncidentsFileBestEffort() {
  const canonicalPath = getCanonicalBybitWsIncidentsPath();
  const legacyPath = getLegacyBybitWsIncidentsPath();
  if (canonicalPath === legacyPath) return;
  if (fs.existsSync(canonicalPath) || !fs.existsSync(legacyPath)) return;
  try {
    ensureIncidentDir();
    fs.copyFileSync(legacyPath, canonicalPath);
  } catch {
    // ignore migration errors; hydration will still best-effort read whichever file exists
  }
}

function safeParseIncident(line: string): BybitWsIncidentRecord | null {
  try {
    const parsed = JSON.parse(line) as BybitWsIncidentRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || typeof parsed.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function hydrateRecentIncidents() {
  if (hydrated) return;
  hydrated = true;
  migrateLegacyIncidentsFileBestEffort();
  try {
    const canonicalPath = getCanonicalBybitWsIncidentsPath();
    const legacyPath = getLegacyBybitWsIncidentsPath();
    const sourcePath = fs.existsSync(canonicalPath)
      ? canonicalPath
      : fs.existsSync(legacyPath)
        ? legacyPath
        : null;
    if (!sourcePath) return;
    const lines = fs.readFileSync(sourcePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_RECENT_INCIDENTS);
    for (const line of lines) {
      const record = safeParseIncident(line);
      if (record) recentIncidents.push(record);
    }
  } catch {
    // ignore hydration errors
  }
}

export function appendBybitWsIncident(
  input: Omit<BybitWsIncidentRecord, "id" | "ts"> & { ts?: number },
): BybitWsIncidentRecord {
  hydrateRecentIncidents();
  const record: BybitWsIncidentRecord = {
    id: randomUUID(),
    ts: Number.isFinite(input.ts) ? Number(input.ts) : Date.now(),
    type: input.type,
    reason: input.reason,
    shardKey: input.shardKey ?? null,
    staleMs: input.staleMs ?? null,
    attempt: input.attempt ?? null,
    recoveredAt: input.recoveredAt ?? null,
    delayMs: input.delayMs ?? null,
    topics: input.topics ?? null,
    eventLoopLagMs: input.eventLoopLagMs ?? null,
    fullReconnect: Boolean(input.fullReconnect),
  };
  recentIncidents.push(record);
  if (recentIncidents.length > MAX_RECENT_INCIDENTS) {
    recentIncidents.splice(0, recentIncidents.length - MAX_RECENT_INCIDENTS);
  }
  try {
    ensureIncidentDir();
    fs.appendFileSync(getBybitWsIncidentsPathInternal(), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // ignore persistence errors; incidents are best-effort diagnostics
  }
  return record;
}

export function listRecentBybitWsIncidents(limit = 50): BybitWsIncidentRecord[] {
  hydrateRecentIncidents();
  const bounded = Math.max(1, Math.min(MAX_RECENT_INCIDENTS, Math.floor(limit) || 50));
  return recentIncidents.slice(-bounded).reverse();
}

export function getBybitWsIncidentsPath(): string {
  return getBybitWsIncidentsPathInternal();
}

export function getLegacyBybitWsIncidentsPathForTests(): string {
  return getLegacyBybitWsIncidentsPath();
}

export function resetBybitWsIncidentStoreForTests() {
  recentIncidents.splice(0, recentIncidents.length);
  hydrated = false;
}
