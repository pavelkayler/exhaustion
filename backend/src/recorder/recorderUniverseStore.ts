import fs from "node:fs";
import path from "node:path";
import { configStore } from "../runtime/configStore.js";

export type RecorderUniverseState = {
  selectedId: string | null;
  symbols: string[];
  updatedAtMs: number;
};

export const AUTO_RECORDER_UNIVERSE_ID = "recorder:auto-24h-turnover-2m";

const RECORDER_UNIVERSE_PATH = path.resolve(process.cwd(), "data", "recorder", "universe.json");

function writeFileAtomic(filePath: string, body: string) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, body, "utf8");
  fs.renameSync(tempPath, filePath);
}

function normalizeSymbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    const symbol = String(item ?? "").trim().toUpperCase();
    if (symbol) out.add(symbol);
  }
  return Array.from(out);
}

function defaultSymbols(): string[] {
  return normalizeSymbols(configStore.get().universe?.symbols ?? []);
}

function defaultState(): RecorderUniverseState {
  return {
    selectedId: AUTO_RECORDER_UNIVERSE_ID,
    symbols: [],
    updatedAtMs: Date.now(),
  };
}

export function readRecorderUniverseState(): RecorderUniverseState {
  if (!fs.existsSync(RECORDER_UNIVERSE_PATH)) return defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(RECORDER_UNIVERSE_PATH, "utf8")) as Partial<RecorderUniverseState>;
    return {
      selectedId: typeof raw?.selectedId === "string" && raw.selectedId.trim() ? raw.selectedId.trim() : null,
      symbols: normalizeSymbols(raw?.symbols),
      updatedAtMs: Number.isFinite(Number(raw?.updatedAtMs)) ? Math.floor(Number(raw?.updatedAtMs)) : Date.now(),
    };
  } catch {
    return defaultState();
  }
}

export function writeRecorderUniverseState(next: RecorderUniverseState): RecorderUniverseState {
  const normalized: RecorderUniverseState = {
    selectedId: typeof next.selectedId === "string" && next.selectedId.trim() ? next.selectedId.trim() : null,
    symbols: normalizeSymbols(next.symbols),
    updatedAtMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(RECORDER_UNIVERSE_PATH), { recursive: true });
  writeFileAtomic(RECORDER_UNIVERSE_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function setRecorderUniverseById(universeId: string): RecorderUniverseState | null {
  const id = String(universeId ?? "").trim();
  if (!id) return null;
  const symbols = defaultSymbols();
  if (symbols.length === 0) return null;
  return writeRecorderUniverseState({
    selectedId: id,
    symbols,
    updatedAtMs: Date.now(),
  });
}

export function setRecorderUniverseSymbols(symbols: string[]): RecorderUniverseState {
  return writeRecorderUniverseState({
    selectedId: null,
    symbols: normalizeSymbols(symbols),
    updatedAtMs: Date.now(),
  });
}

export function setAutoRecorderUniverseSymbols(symbols: string[]): RecorderUniverseState {
  return writeRecorderUniverseState({
    selectedId: AUTO_RECORDER_UNIVERSE_ID,
    symbols: normalizeSymbols(symbols),
    updatedAtMs: Date.now(),
  });
}

export function resolveRecorderSymbols(): string[] {
  const state = readRecorderUniverseState();
  if (state.symbols.length > 0) return state.symbols;
  if (state.selectedId === AUTO_RECORDER_UNIVERSE_ID) return [];
  return defaultSymbols();
}
