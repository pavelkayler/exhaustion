export function computeReconnectDelay(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  const expDelay = Math.min(maxMs, baseMs * (2 ** Math.min(safeAttempt, 10)));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(maxMs, expDelay + jitter);
}
