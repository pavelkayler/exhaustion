import WebSocket from "ws";

type BybitWsOp = "subscribe" | "unsubscribe" | "ping";

type BybitWsReq = {
  op: BybitWsOp;
  args?: string[];
};

type Handlers = {
  onTicker: (topic: string, type: "snapshot" | "delta", data: Record<string, any>) => void;
  onKline: (topic: string, type: "snapshot" | "delta", data: Record<string, any>) => void;
  onOrderbook?: (topic: string, type: "snapshot" | "delta", data: Record<string, any>) => void;
  onPublicTrade?: (topic: string, data: Record<string, any>) => void;
  onLiquidation?: (topic: string, data: Record<string, any>) => void;
  onOpen?: () => void;
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
    return [data];
  }
  return [];
}

export class BybitWsClient {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  private readonly url: string;
  private readonly handlers: Handlers;

  constructor(url: string, handlers: Handlers) {
    this.url = url;
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    if (this.ws) return;

    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.handlers.onOpen?.();

      // keep-alive (Bybit принимает op:ping)
      this.pingTimer = setInterval(() => {
        this.send({ op: "ping" });
      }, 20_000);
    });

    this.ws.on("message", (buf) => {
      const msgStr = typeof buf === "string" ? buf : buf.toString("utf8");
      const msg = safeJsonParse(msgStr);
      if (!msg) return;

      // service responses: { op: "pong" }, { success: true }, etc.
      if (msg.op || typeof msg.success === "boolean") return;

      const topic = msg.topic as string | undefined;
      const rows = normalizeData(msg.data);
      if (!topic) return;

      if (topic.startsWith("publicTrade.")) {
        for (const row of rows) this.handlers.onPublicTrade?.(topic, row);
        return;
      }

      if (topic.startsWith("allLiquidation.")) {
        for (const row of rows) this.handlers.onLiquidation?.(topic, row);
        return;
      }

      const type = msg.type as "snapshot" | "delta" | undefined;
      if (type !== "snapshot" && type !== "delta") return;

      if (topic.startsWith("tickers.")) {
        for (const row of rows) this.handlers.onTicker(topic, type, row);
      } else if (topic.startsWith("orderbook.")) {
        for (const row of rows) this.handlers.onOrderbook?.(topic, type, row);
      } else if (topic.startsWith("kline.")) {
        for (const row of rows) this.handlers.onKline(topic, type, row);
      }
    });

    this.ws.on("close", () => {
      this.handlers.onClose?.();
      this.cleanup();
    });

    this.ws.on("error", (err) => {
      this.handlers.onError?.(err);
    });
  }

  subscribe(topics: string[]) {
    this.send({ op: "subscribe", args: topics });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.cleanup();
  }

  hardClose(): void {
    try {
      (this.ws as any)?.terminate?.();
    } catch {
      // ignore
    }
    this.cleanup();
  }

  private send(payload: BybitWsReq) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
      }
    } catch {
      // ignore
    }
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }
}
