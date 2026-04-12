
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
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

function isLocalRequestIp(ip: string | null | undefined): boolean {
  const normalized = String(ip ?? "").trim();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.endsWith("127.0.0.1");
}

function readNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function setShutdownHandler(handler: (() => Promise<void> | void) | null) {
  shutdownHandler = handler;
}

export async function requestOptimizerGracefulPauseAndFlush(_args?: { timeoutMs?: number }): Promise<void> {
  return;
}

export function registerHttpRoutes(app: FastifyInstance) {
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
      const mode = String(body.mode ?? "").trim().toLowerCase() === "real" ? "real" : "demo";
      return await refreshPrivateExecutionSnapshot(mode);
    } catch (error) {
      reply.code(400);
      return { error: String((error as Error)?.message ?? error) };
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
      executionMode: String(body.executionMode ?? "").trim().toLowerCase() === "real" ? "real" : "demo",
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
