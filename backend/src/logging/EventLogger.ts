import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";

export type LogEvent = {
  ts: number;
  type: string;
  symbol?: string;
  payload?: unknown;
};

export class EventLogger {
  public readonly sessionId: string;
  public readonly filePath: string;

  private readonly onEvent: ((ev: LogEvent) => void) | undefined;
  private readonly stream: fs.WriteStream;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(sessionId: string, onEvent?: (ev: LogEvent) => void) {
    this.sessionId = sessionId;
    this.onEvent = onEvent;

    const dir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(dir, { recursive: true });

    this.filePath = path.join(dir, "events.jsonl");
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });

    this.log({
      ts: Date.now(),
      type: "SESSION_START",
      payload: { sessionId }
    });
  }

  log(ev: LogEvent) {
    if (!this.closed) {
      const line = `${JSON.stringify(ev)}
`;
      this.writeChain = this.writeChain.then(async () => {
        if (this.closed) return;
        try {
          const ok = this.stream.write(line, "utf8");
          if (!ok) {
            await once(this.stream, "drain");
          }
        } catch {
          // ignore
        }
      });
    }

    try {
      this.onEvent?.(ev);
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      try {
        await this.writeChain;
      } catch {
        // ignore
      }
      try {
        this.stream.end();
        if (!this.stream.closed) {
          await once(this.stream, "close");
        }
      } catch {
        // ignore
      }
    })();
    return this.closePromise;
  }
}
