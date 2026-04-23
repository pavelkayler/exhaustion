import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;

  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();

  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }

  val = val.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");

  if (!key) return null;
  return [key, val];
}

function loadEnvFile(filePath: string, options?: { override?: boolean }) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const kv = parseEnvLine(line);
    if (!kv) continue;
    const [k, v] = kv;
    if (options?.override || process.env[k] === undefined) process.env[k] = v;
  }
}

(() => {
  const cwd = process.cwd();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const primaryCandidates = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "backend", ".env"),
  ];
  const fallbackCandidates = [
    path.resolve(cwd, "..", ".env"),
    path.resolve(cwd, "..", "backend", ".env"),
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
  ];

  let primaryLoaded = false;
  const seen = new Set<string>();
  for (const p of [...primaryCandidates, ...fallbackCandidates]) {
    const k = path.normalize(p);
    if (seen.has(k)) continue;
    seen.add(k);
    const isPrimary = primaryCandidates.some(
      (candidate) => path.normalize(candidate) === k,
    );
    if (isPrimary && fs.existsSync(k)) {
      loadEnvFile(k, { override: true });
      primaryLoaded = true;
      continue;
    }
    if (!primaryLoaded) {
      loadEnvFile(k, { override: false });
      continue;
    }
    loadEnvFile(k, { override: false });
  }
})();

import "./engine/patchShortExhaustionNoSoftFinal.js";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import cors from "@fastify/cors";
import {
  registerHttpRoutes,
  requestOptimizerGracefulPauseAndFlush,
  setShutdownHandler,
} from "./api/http.js";
import { awaitAllStreamsConnected, createWsHub } from "./api/wsHub.js";
import { createPrivatePositionsWs } from "./api/privatePositionsWs.js";
import { runtime } from "./runtime/runtime.js";
import { ServerLogStream } from "./logging/ServerLogStream.js";
import { startTopOpenInterestUniverseScheduler } from "./runtime/topOpenInterestUniverse.js";

const serverLogStream = new ServerLogStream();
const restoreConsoleCapture = serverLogStream.captureConsole();

process.on("unhandledRejection", (reason) => {
  serverLogStream.appendRecord({
    ts: Date.now(),
    source: "process",
    level: "error",
    msg: `[process] unhandledRejection ${String(
      (reason as any)?.stack ?? (reason as any)?.message ?? reason,
    )}`,
  });
});

process.on("uncaughtExceptionMonitor", (error) => {
  serverLogStream.appendRecord({
    ts: Date.now(),
    source: "process",
    level: "fatal",
    msg: `[process] uncaughtException ${String(
      error?.stack ?? error?.message ?? error,
    )}`,
  });
});

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      stream: serverLogStream,
      base: {
        pid: process.pid,
        bootSessionId: serverLogStream.bootSessionId,
      },
    },
  });

  app.register(formbody);

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);

      const ok = /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin);
      return cb(null, ok);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });

  registerHttpRoutes(app);
  createWsHub(app);
  createPrivatePositionsWs(app);

  return app;
}

function shouldAutoStartRuntime(): boolean {
  const raw = String(
    process.env.AUTO_START_RUNTIME ??
      process.env.AUTO_START_SESSION ??
      "0",
  )
    .trim()
    .toLowerCase();

  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

async function autoStartRuntime(app: Awaited<ReturnType<typeof buildApp>>) {
  if (!shouldAutoStartRuntime()) {
    app.log.info("runtime auto-start disabled");
    return;
  }

  try {
    const status = await runtime.start({
      waitForReady: async ({ signal }) => {
        await awaitAllStreamsConnected({
          timeoutMs: 15_000,
          signal,
        });
      },
    });

    if (status.sessionState === "RUNNING") {
      app.log.info(
        {
          sessionState: status.sessionState,
          runningBotName: status.runningBotName,
        },
        "runtime auto-started",
      );
      return;
    }

    app.log.warn(
      {
        sessionState: status.sessionState,
        runtimeMessage: status.runtimeMessage,
      },
      "runtime auto-start finished without RUNNING state",
    );
  } catch (error) {
    app.log.error(
      { error: String((error as Error)?.message ?? error) },
      "runtime auto-start failed",
    );
  }
}

async function main() {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";

  const app = await buildApp();
  const stopTopOpenInterestUniverseScheduler = startTopOpenInterestUniverseScheduler(
    app.log,
  );
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = 0;
    try {
      app.log.info({ signal }, "shutdown requested");
      stopTopOpenInterestUniverseScheduler();
      const st = runtime.getStatus();
      if (
        st.sessionState === "RUNNING" ||
        st.sessionState === "PAUSED" ||
        st.sessionState === "STOPPING"
      ) {
        await runtime.stop(`graceful_shutdown:${signal}`);
      }
      await requestOptimizerGracefulPauseAndFlush({ timeoutMs: 3_000 });
      await app.close();
    } catch (err) {
      exitCode = 1;
      app.log.error({ err, signal }, "graceful shutdown failed");
    } finally {
      restoreConsoleCapture();
      process.exit(exitCode);
    }
  };
  setShutdownHandler(() => gracefulShutdown("admin"));
  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });

  await app.listen({ port, host });

  app.log.info(
    { host, port, bootSessionId: serverLogStream.bootSessionId },
    "backend listening",
  );

  await autoStartRuntime(app);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
