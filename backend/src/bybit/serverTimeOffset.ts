let offsetMs = 0;
let loggedRefreshFailure = false;
let schedulerStarted = false;
let refreshInFlight: Promise<void> | null = null;

type ServerTimeClient = {
  baseUrl?: string;
};

function parseServerTimeMs(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { result?: Record<string, unknown> };
  const result = root.result;
  if (!result || typeof result !== "object") return null;
  const timeNano = Number(result.timeNano);
  if (Number.isFinite(timeNano) && timeNano > 0) {
    return Math.floor(timeNano / 1_000_000);
  }
  const timeSecond = Number(result.timeSecond);
  if (Number.isFinite(timeSecond) && timeSecond > 0) {
    return Math.floor(timeSecond * 1000);
  }
  return null;
}

async function fetchServerTimeMs(baseUrl: string): Promise<number> {
  const res = await fetch(`${baseUrl}/v5/market/time`, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`time endpoint failed with status ${res.status}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("time endpoint returned invalid json");
  }
  const serverTimeMs = parseServerTimeMs(parsed);
  if (!Number.isFinite(serverTimeMs) || !serverTimeMs || serverTimeMs <= 0) {
    throw new Error("time endpoint missing server time fields");
  }
  return serverTimeMs;
}

export async function refreshServerTimeOffset(client: ServerTimeClient): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const task = (async () => {
    const baseUrl = client.baseUrl ?? process.env.BYBIT_DEMO_REST_URL ?? "https://api-demo.bybit.com";
    try {
      const before = Date.now();
      const serverTimeMs = await fetchServerTimeMs(baseUrl);
      const after = Date.now();
      const midpoint = Math.floor((before + after) / 2);
      offsetMs = serverTimeMs - midpoint;
      loggedRefreshFailure = false;
    } catch (err) {
      if (!loggedRefreshFailure) {
        loggedRefreshFailure = true;
        console.warn("[bybit] failed to refresh server time offset", err);
      }
    }
  })();
  refreshInFlight = task;
  try {
    await task;
  } finally {
    refreshInFlight = null;
  }
}

export function startServerTimeOffsetScheduler(client: ServerTimeClient, intervalMs = 5 * 60_000): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  void refreshServerTimeOffset(client);
  const timer = setInterval(() => {
    void refreshServerTimeOffset(client);
  }, intervalMs);
  timer.unref?.();
}

export function nowMs(): number {
  return Date.now() + offsetMs;
}

export function getOffsetMs(): number {
  return offsetMs;
}
