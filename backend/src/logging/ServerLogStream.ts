import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

export type ServerLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type ServerLogSource = "pino" | "console" | "process";

export type ServerLogRecord = {
  ts: number;
  isoTime: string;
  bootSessionId: string;
  pid: number;
  source: ServerLogSource;
  level: ServerLogLevel;
  msg: string;
};

type ConsoleMethodName = "log" | "info" | "warn" | "error";

type ConsoleCaptureCleanup = () => void;

type ServerLogStreamOptions = {
  rootDir?: string;
  bootSessionId?: string;
  maxFileBytes?: number;
  now?: () => number;
  stdoutWrite?: (chunk: string) => void;
};

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function safeConsoleMessage(args: unknown[]): string {
  return util.format(...args);
}

function buildLogFileName(bootSessionId: string, part: number): string {
  return `${bootSessionId}.part-${String(part).padStart(4, "0")}.jsonl`;
}

function shouldMirrorLogsToStdout(): boolean {
  const raw = String(process.env.SERVER_LOG_STDOUT ?? "0").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export class ServerLogStream {
  public readonly bootSessionId: string;

  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly stdoutWrite: (chunk: string) => void;
  private readonly mirrorToStdout: boolean;
  private currentDayKey: string | null = null;
  private currentPart = 1;
  private currentFilePath: string | null = null;
  private currentFileBytes = 0;

  constructor(options?: ServerLogStreamOptions) {
    this.rootDir = path.resolve(options?.rootDir ?? path.join(process.cwd(), "data", "logs", "server"));
    this.bootSessionId = String(options?.bootSessionId ?? `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`);
    this.maxFileBytes = Math.max(256 * 1024, Math.floor(Number(options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES));
    this.now = options?.now ?? (() => Date.now());
    this.stdoutWrite = options?.stdoutWrite ?? ((chunk) => {
      process.stdout.write(chunk);
    });
    this.mirrorToStdout = shouldMirrorLogsToStdout();
  }

  write(chunk: string): void {
    const text = String(chunk ?? "");
    if (!text) return;
    if (this.mirrorToStdout) {
      this.stdoutWrite(text);
    }
    this.appendRawLine(text, this.now());
  }

  appendRecord(record: Omit<ServerLogRecord, "bootSessionId" | "pid" | "isoTime"> & { isoTime?: string }): void {
    const ts = Number.isFinite(record.ts) ? Number(record.ts) : this.now();
    const line = JSON.stringify({
      ...record,
      ts,
      isoTime: record.isoTime ?? new Date(ts).toISOString(),
      bootSessionId: this.bootSessionId,
      pid: process.pid,
    }) + "\n";
    this.appendRawLine(line, ts);
  }

  captureConsole(): ConsoleCaptureCleanup {
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    } satisfies Record<ConsoleMethodName, (...args: unknown[]) => void>;

    const levels: Record<ConsoleMethodName, ServerLogLevel> = {
      log: "info",
      info: "info",
      warn: "warn",
      error: "error",
    };

    const install = (method: ConsoleMethodName) => {
      console[method] = (...args: unknown[]) => {
        if (this.mirrorToStdout) {
          original[method](...args);
        }
        this.appendRecord({
          ts: this.now(),
          source: "console",
          level: levels[method],
          msg: safeConsoleMessage(args),
        });
      };
    };

    install("log");
    install("info");
    install("warn");
    install("error");

    return () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    };
  }

  private appendRawLine(line: string, ts: number): void {
    const normalized = String(line ?? "");
    if (!normalized) return;
    this.ensureTarget(ts, Buffer.byteLength(normalized, "utf8"));
    if (!this.currentFilePath) return;
    fs.appendFileSync(this.currentFilePath, normalized, "utf8");
    this.currentFileBytes += Buffer.byteLength(normalized, "utf8");
  }

  private ensureTarget(ts: number, nextBytes: number): void {
    const dayKey = formatLocalDayKey(ts);
    if (!this.currentFilePath || this.currentDayKey !== dayKey) {
      this.currentDayKey = dayKey;
      this.currentPart = 1;
      this.currentFilePath = this.resolveFilePath(dayKey, this.currentPart);
      this.currentFileBytes = fs.existsSync(this.currentFilePath) ? fs.statSync(this.currentFilePath).size : 0;
    }
    if (this.currentFileBytes + nextBytes <= this.maxFileBytes) return;
    this.currentPart += 1;
    this.currentFilePath = this.resolveFilePath(dayKey, this.currentPart);
    this.currentFileBytes = fs.existsSync(this.currentFilePath) ? fs.statSync(this.currentFilePath).size : 0;
  }

  private resolveFilePath(dayKey: string, part: number): string {
    const dir = path.join(this.rootDir, dayKey);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, buildLogFileName(this.bootSessionId, part));
  }
}
