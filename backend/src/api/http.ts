import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { BybitDemoRestClient } from "../bybit/BybitDemoRestClient.js";
import { BybitRealRestClient } from "../bybit/BybitRealRestClient.js";
import { runtime } from "../runtime/runtime.js";
import { configStore } from "../runtime/configStore.js";
import {
  awaitAllStreamsConnected,
  requestStreamLifecycleSync,
  submitManualTestOrder,
} from "./wsHub.js";
import {
  getExecutionExecutorState,
  refreshPrivateExecutionSnapshot,
  startExecutionExecutor,
  stopExecutionExecutor,
  updateExecutionExecutorSettings,
} from "./privatePositionsWs.js";

let shutdownHandler: (() => Promise<void> | void) | null = null;

type ExecutionMode = "demo" | "real";

type ExecutionSnapshot = {
  positions: Array<{
    key: string;
    symbol: string;
    side: string | null;
    size: number | null;
    positionIdx?: number | null;
  }>;
  orders: Array<{
    key: string;
    symbol: string;
  }>;
};

function isLocalRequestIp(ip: string | null | undefined): boolean {
  const normalized = String(ip ?? "").trim();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.endsWith("127.0.0.1");
}

function readNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeMode(value: unknown): ExecutionMode {
  return String(value ?? "").trim().toLowerCase() === "real" ? "real" : "demo";
}

function formatApiNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(12);
  return text.replace(/\.?0+$/, "") || "0";
}

function normalizePositionIdx(value: unknown): 0 | 1 | 2 {
  const numeric = Math.floor(Number(value));
  if (numeric === 1 || numeric === 2) return numeric;
  return 0;
}

function extractOrderLinkId(symbol: string, key: string): string | null {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!normalizedSymbol) return null;
  const prefix = `${normalizedSymbol}:`;
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length).trim();
  return suffix || null;
}

export function setShutdownHandler(handler: (() => Promise<void> | void) | null) {
  shutdownHandler = handler;
}

export async function requestOptimizerGracefulPauseAndFlush(_args?: { timeoutMs?: number }): Promise<void> {
  return;
}

export function registerHttpRoutes(app: FastifyInstance) {
  const realExecutionRestClient = new BybitRealRestClient();
  const demoExecutionRestClient = new BybitDemoRestClient();

  const getExecutionRestClient = (mode: ExecutionMode) => (
    mode === "real" ? realExecutionRestClient : demoExecutionRestClient
  );

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/admin/shutdown", async (req, reply) => {
    if (!isLocalRequestIp((req as any).ip)) {
      reply.code(403);
      return { error: "forbidden" };
    }
    await shutdownHandler?.();
    return { ok: true };
  });

  app.get("/api/session/status", async () => runtime.getStatus());

  app.post("/api/session/start", async (_req, reply) => {
    try {
      return await runtime.start({
        waitForReady: async ({ signal }) => {
          await awaitAllStreamsConnected({
            timeoutMs: 15_000,
            signal,
          });
        },
      });
    } catch (error) {
      reply.code(503);
      return {
        ...runtime.getStatus(),
        runtimeMessage: String((error as Error)?.message ?? error),
      };
    }
  });

  app.post("/api/session/stop", async () => await runtime.stop("manual_stop"));
  app.post("/api/session/pause", async () => runtime.pause());
  app.post("/api/session/resume", async () => runtime.resume());

  app.get("/api/executor/status", async () => getExecutionExecutorState());

  app.post("/api/executor/settings", async (req) => {
    return updateExecutionExecutorSettings((req.body ?? {}) as Record<string, unknown>);
  });

  app.post("/api/executor/start", async (_req, reply) => {
    try {
      return await startExecutionExecutor();
    } catch (error) {
      reply.code(400);
      return {
        ...getExecutionExecutorState(),
        error: String((error as Error)?.message ?? error),
      };
    }
  });

  app.post("/api/executor/stop", async () => {
    return await stopExecutionExecutor();
  });

  app.post("/api/execution/refresh", async (req, reply) => {
    try {
      const body = ((req.body ?? {}) as Record<string, unknown>) ?? {};
      const mode = normalizeMode(body.mode);
      return await refreshPrivateExecutionSnapshot(mode);
    } catch (error) {
      reply.code(400);
      return { error: String((error as Error)?.message ?? error) };
    }
  });

  app.post("/api/execution/positions/close-market", async (req, reply) => {
    const body = ((req.body ?? {}) as Record<string, unknown>) ?? {};
    const mode = normalizeMode(body.mode);
    const key = String(body.key ?? "").trim();

    if (!key) {
      reply.code(400);
      return { error: "position_key_required" };
    }

    try {
      const client = getExecutionRestClient(mode);
      if (!client.hasCredentials()) {
        reply.code(400);
        return { error: "missing_credentials" };
      }

      const snapshot = await refreshPrivateExecutionSnapshot(mode) as ExecutionSnapshot;
      const position = snapshot.positions.find((row) => row.key === key);

      if (!position) {
        reply.code(404);
        return { error: "position_not_found" };
      }

      const size = Number(position.size);
      const side = String(position.side ?? "").trim().toUpperCase();
      if (!(size > 0)) {
        reply.code(400);
        return { error: "position_size_invalid" };
      }
      if (side !== "BUY" && side !== "SELL") {
        reply.code(400);
        return { error: "position_side_invalid" };
      }

      const closeSide = side === "BUY" ? "Sell" : "Buy";
      const positionIdx = normalizePositionIdx(position.positionIdx);

      app.log.info(
        { mode, key, symbol: position.symbol, side, size, positionIdx, closeSide },
        "execution close market requested",
      );

      await client.placeOrderLinear({
        symbol: position.symbol,
        side: closeSide,
        orderType: "Market",
        qty: formatApiNumber(size),
        reduceOnly: true,
        positionIdx,
      });

      app.log.info(
        { mode, key, symbol: position.symbol, side, size, positionIdx, closeSide },
        "execution close market accepted",
      );

      return { ok: true };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      app.log.warn({ mode, key, error: message }, "execution close market failed");
      reply.code(400);
      return { error: message };
    }
  });

  app.post("/api/execution/orders/cancel", async (req, reply) => {
    const body = ((req.body ?? {}) as Record<string, unknown>) ?? {};
    const mode = normalizeMode(body.mode);
    const key = String(body.key ?? "").trim();

    if (!key) {
      reply.code(400);
      return { error: "order_key_required" };
    }

    try {
      const client = getExecutionRestClient(mode);
      if (!client.hasCredentials()) {
        reply.code(400);
        return { error: "missing_credentials" };
      }

      const snapshot = await refreshPrivateExecutionSnapshot(mode) as ExecutionSnapshot;
      const order = snapshot.orders.find((row) => row.key === key);

      if (!order) {
        reply.code(404);
        return { error: "order_not_found" };
      }

      const orderLinkId = extractOrderLinkId(order.symbol, key);

      app.log.info(
        { mode, key, symbol: order.symbol, orderId: orderLinkId ? null : key, orderLinkId },
        "execution cancel order requested",
      );

      await client.cancelOrderLinear({
        symbol: order.symbol,
        ...(orderLinkId ? { orderLinkId } : { orderId: key }),
      });

      app.log.info(
        { mode, key, symbol: order.symbol, orderId: orderLinkId ? null : key, orderLinkId },
        "execution cancel order accepted",
      );

      return { ok: true };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      app.log.warn({ mode, key, error: message }, "execution cancel order failed");
      reply.code(400);
      return { error: message };
    }
  });

  app.get("/api/process/status", async () => {
    const status = runtime.getStatus();
    return {
      serverBootId: process.pid,
      runtime: {
        state: status.sessionState,
        runningSinceMs: status.runningSinceMs ?? null,
        message: status.runtimeMessage ?? null,
      },
      optimizer: {
        state: "stopped",
        runIndex: 0,
        runsCount: 0,
        isInfinite: false,
        currentJobId: null,
        jobStatus: null,
        progressPct: 0,
        message: null,
      },
      receiveData: {
        state: "idle",
        jobId: null,
        progressPct: 0,
        currentSymbol: null,
        message: null,
        etaSec: null,
      },
      recorder: {
        state: "idle",
        mode: "off",
        progressPct: null,
        message: null,
      },
    };
  });

  app.get("/api/config", async () => ({
    config: configStore.get(),
  }));

  app.post("/api/config", async (req) => {
    const next = configStore.update(req.body ?? {});
    configStore.persist();
    requestStreamLifecycleSync();
    return {
      config: next,
      applied: {
        universeSymbolsCount: next.universe.symbols.length,
        universeSelectedId: next.universe.selectedId ?? "",
      },
    };
  });

  app.post("/api/manual-test-order", async (req, reply) => {
    const body = ((req.body ?? {}) as Record<string, unknown>) ?? {};
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    const side = String(body.side ?? "").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    if (!symbol) {
      reply.code(400);
      return { ok: false, accepted: false, reason: "symbol_required", message: "symbol_required" };
    }
    const manualOrderArgs: {
      symbol: string;
      side: "LONG" | "SHORT";
      executionMode: "demo" | "real";
      entryPrice?: number;
      tpPrice?: number;
      slPrice?: number;
      marginUSDT?: number;
      leverage?: number;
    } = {
      symbol,
      side,
      executionMode: normalizeMode(body.executionMode),
    };
    const entryPrice = readNumber(body.entryPrice);
    const tpPrice = readNumber(body.tpPrice);
    const slPrice = readNumber(body.slPrice);
    const marginUSDT = readNumber(body.marginUSDT);
    const leverage = readNumber(body.leverage);
    if (entryPrice != null) manualOrderArgs.entryPrice = entryPrice;
    if (tpPrice != null) manualOrderArgs.tpPrice = tpPrice;
    if (slPrice != null) manualOrderArgs.slPrice = slPrice;
    if (marginUSDT != null) manualOrderArgs.marginUSDT = marginUSDT;
    if (leverage != null) manualOrderArgs.leverage = leverage;
    return await submitManualTestOrder(manualOrderArgs);
  });

  app.get("/api/session/events/download", async (_req, reply) => {
    const status = runtime.getStatus();
    const eventsFile = String(status.eventsFile ?? "").trim();
    if (!eventsFile || !fs.existsSync(eventsFile)) {
      reply.code(404);
      return { error: "events_not_found" };
    }
    reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="session-events.jsonl"');
    return reply.send(fs.readFileSync(eventsFile, "utf8"));
  });
}
