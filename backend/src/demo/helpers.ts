import type { PaperSide } from "../paper/PaperBroker.js";

export function calcTpSl(entry: number, side: PaperSide, leverage: number, tpRoiPct: number, slRoiPct: number) {
  const tpMove = (tpRoiPct / 100) / leverage;
  const slMove = (slRoiPct / 100) / leverage;
  if (side === "LONG") return { tp: entry * (1 + tpMove), sl: entry * (1 - slMove) };
  return { tp: entry * (1 - tpMove), sl: entry * (1 + slMove) };
}

export function compactOrderLinkId(prefix: string, runId: string, symbol: string, attempt: number, nowMs: number): string {
  const safePrefix = String(prefix ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase();
  const safeRun = String(runId ?? "").replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  const safeSymbol = String(symbol ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 12).toUpperCase();
  const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0)).toString(36);
  const safeTs = Math.max(0, Math.floor(Number(nowMs) || 0)).toString(36);
  return `${safePrefix}${safeRun}${safeSymbol}${safeAttempt}${safeTs}`.slice(0, 45);
}
