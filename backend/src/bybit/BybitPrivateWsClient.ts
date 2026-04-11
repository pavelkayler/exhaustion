import WebSocket from "ws";
import { createHmac } from "node:crypto";

type PrivateHandlers = {
  onOrder?: (row: Record<string, any>) => void;
  onExecution?: (row: Record<string, any>) => void;
  onPosition?: (row: Record<string, any>) => void;
  onWallet?: (row: Record<string, any>) => void;
  onMessage?: (msg: Record<string, any>) => void;
  onOpen?: () => void;
  onAuthed?: () => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
};

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeData(data: any): Array<Record<string, any>> {
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === "object");
  }
  if (data && typeof data === "object") {
    if (Array.isArray(data.list)) {
      return data.list.filter((x: any) => x && typeof x === "object");
    }
    return [data];
  }
  return [];
}

function buildWsAuthSignature(apiSecret: string, expiresMs: number): string {
  return createHmac("sha256", apiSecret)
    .update(`GET/realtime${expiresMs}`)
    .digest("hex")
    .toLowerCase();
}

export class BybitPrivateWsClient {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private authed = false;
  private readonly subscriptions = new Set<string>();

  constructor(
    private readonly args: {
      url: string;
      apiKey: string;
      apiSecret: string;
      handlers: PrivateHandlers;
    },
  ) {}

  connect(): void {
    if (this.ws || !this.args.apiKey || !this.args.apiSecret) return;
    this.shouldReconnect = true;
    const ws = new WebSocket(this.args.url);
    this.ws = ws;

    ws.on("open", () => {
      this.args.handlers.onOpen?.();
      this.authed = false;
      this.sendAuth();
      this.pingTimer = setInterval(() => {
        this.send({ op: "ping" });
      }, 20_000);
    });

    ws.on("message", (buf) => {
      const msgStr = typeof buf === "string" ? buf : buf.toString("utf8");
      const msg = safeJsonParse(msgStr);
      if (!msg) return;
      this.args.handlers.onMessage?.(msg);

      if (msg.op === "auth") {
        if (msg.success) {
          this.authed = true;
          this.args.handlers.onAuthed?.();
          this.flushSubscriptions();
        }
        return;
      }

      if (msg.op || typeof msg.success === "boolean") return;

      const topic = String(msg.topic ?? "");
      if (!topic) return;
      const rows = normalizeData(msg.data);

      if (topic === "order") {
        for (const row of rows) this.args.handlers.onOrder?.(row);
        return;
      }
      if (topic === "execution") {
        for (const row of rows) this.args.handlers.onExecution?.(row);
        return;
      }
      if (topic === "position") {
        for (const row of rows) this.args.handlers.onPosition?.(row);
        return;
      }
      if (topic === "wallet") {
        if (rows.length > 0) {
          for (const row of rows) this.args.handlers.onWallet?.(row);
        } else if (msg.data && typeof msg.data === "object") {
          this.args.handlers.onWallet?.(msg.data);
        }
      }
    });

    ws.on("close", () => {
      this.cleanupSocket();
      this.args.handlers.onClose?.();
      if (!this.shouldReconnect) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 1500);
    });

    ws.on("error", (err) => {
      this.args.handlers.onError?.(err);
    });
  }

  subscribe(topics: string[]) {
    for (const topic of topics) {
      const normalized = String(topic ?? "").trim();
      if (normalized) this.subscriptions.add(normalized);
    }
    this.flushSubscriptions();
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.cleanupSocket();
  }

  private sendAuth() {
    const expiresMs = Date.now() + 10_000;
    const sign = buildWsAuthSignature(this.args.apiSecret, expiresMs);
    this.send({
      op: "auth",
      args: [this.args.apiKey, expiresMs, sign],
    });
  }

  private flushSubscriptions() {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.subscriptions.size === 0) return;
    this.send({ op: "subscribe", args: Array.from(this.subscriptions) });
  }

  private send(payload: { op: string; args?: unknown[] }) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
      }
    } catch {
      // ignore
    }
  }

  private cleanupSocket() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
    this.authed = false;
  }
}
