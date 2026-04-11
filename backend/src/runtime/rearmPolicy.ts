export const FIXED_ENTRY_TIMEOUT_SEC = 5 * 60;
export const FIXED_ENTRY_TIMEOUT_MS = FIXED_ENTRY_TIMEOUT_SEC * 1000;
export const GLOBAL_REARM_CANDLE_MS = 5 * 60_000;

export function getGlobalRearmCandleEndMs(nowMs: number): number {
  const ts = Number(nowMs);
  if (!Number.isFinite(ts) || ts <= 0) return GLOBAL_REARM_CANDLE_MS;
  return Math.floor(ts / GLOBAL_REARM_CANDLE_MS) * GLOBAL_REARM_CANDLE_MS + GLOBAL_REARM_CANDLE_MS;
}

export function getGlobalRearmCooldownRemainingMs(nowMs: number): number {
  const endMs = getGlobalRearmCandleEndMs(nowMs);
  return Math.max(0, endMs - Math.floor(Number(nowMs) || 0));
}

export function applyGlobalRearmCooldown(_currentCooldownUntil: number, nowMs: number): number {
  return getGlobalRearmCandleEndMs(nowMs);
}
