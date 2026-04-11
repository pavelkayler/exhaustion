import fs from "node:fs";
import path from "node:path";

export type PersistedRecorderMode = "off" | "record_only" | "record_while_running";

type RecorderSettingsState = {
  mode: PersistedRecorderMode;
  historyId: string | null;
};

const RECORDER_SETTINGS_PATH = path.resolve(process.cwd(), "data", "recorder", "settings.json");

function writeFileAtomic(filePath: string, body: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeMode(value: unknown): PersistedRecorderMode {
  if (value === "record_only" || value === "record_while_running") return value;
  return "off";
}

function normalizeHistoryId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readRecorderSettings(): RecorderSettingsState {
  if (!fs.existsSync(RECORDER_SETTINGS_PATH)) {
    return { mode: "off", historyId: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(RECORDER_SETTINGS_PATH, "utf8")) as Partial<RecorderSettingsState>;
    return {
      mode: normalizeMode(raw?.mode),
      historyId: normalizeHistoryId(raw?.historyId),
    };
  } catch {
    return { mode: "off", historyId: null };
  }
}

export function readResolvedRecorderSettings(): RecorderSettingsState {
  return readRecorderSettings();
}

export function writeRecorderSettings(next: Partial<RecorderSettingsState>): RecorderSettingsState {
  const current = readRecorderSettings();
  const normalized: RecorderSettingsState = {
    mode: normalizeMode(next.mode ?? current.mode),
    historyId: normalizeHistoryId(next.historyId) ?? current.historyId,
  };
  writeFileAtomic(RECORDER_SETTINGS_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}
