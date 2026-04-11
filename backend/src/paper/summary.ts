import fs from "node:fs";
import path from "node:path";

export type PaperTrade = {
  symbol: string;
  side: "LONG" | "SHORT";
  openedAt: number | null;
  closedAt: number;
  entryPrice: number;
  closePrice: number;
  qty: number;
  closeType: "TP" | "SL" | "FORCE";
  pnlFromMove: number;
  fundingAccrued: number;
  feesPaid: number;
  realizedPnl: number;
  holdMs: number | null;
};

export type PaperSummary = {
  generatedAt: number;
  sessionId: string | null;
  startTs: number | null;
  endTs: number | null;
  durationSec: number | null;

  trades: {
    total: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    expectancy: number | null;
    avgHoldSec: number | null;
  };

  pnl: {
    netRealized: number;
    grossFromMove: number;
    funding: number;
    fees: number;
  };

  equity: {
    maxDrawdown: number | null;
    peak: number;
    trough: number;
  };

  perSymbol: Array<{
    symbol: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netRealized: number;
  }>;
};

type LogEvent = {
  ts: number;
  type: string;
  symbol?: string;
  payload?: any;
};

function safeParseJsonLine(line: string): LogEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj.ts === "number" && typeof obj.type === "string") return obj;
    return null;
  } catch {
    return null;
  }
}

function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = nums.reduce((a, b) => a + b, 0);
  return s / nums.length;
}

function round(n: number, digits = 8): number {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

export function computePaperSummaryFromEvents(args: { sessionId: string | null; eventsFile: string }): { summary: PaperSummary; trades: PaperTrade[] } {
  const { sessionId, eventsFile } = args;

  const text = fs.readFileSync(eventsFile, "utf8");
  const lines = text.split(/\r?\n/);

  const openBySymbol = new Map<string, { openedAt: number; side: "LONG" | "SHORT"; entryPrice: number; qty: number }>();
  const trades: PaperTrade[] = [];

  let startTs: number | null = null;
  let endTs: number | null = null;

  for (const line of lines) {
    const ev = safeParseJsonLine(line);
    if (!ev) continue;

    if (startTs == null) startTs = ev.ts;
    endTs = ev.ts;

    if (ev.type === "POSITION_OPEN" && ev.symbol && ev.payload) {
      const side = ev.payload.side as "LONG" | "SHORT";
      const entryPrice = Number(ev.payload.entryPrice);
      const qty = Number(ev.payload.qty);
      if ((side === "LONG" || side === "SHORT") && Number.isFinite(entryPrice) && Number.isFinite(qty)) {
        openBySymbol.set(ev.symbol, { openedAt: ev.ts, side, entryPrice, qty });
      }
      continue;
    }

    const isClose =
      ev.type === "POSITION_CLOSE_TP" ||
      ev.type === "POSITION_CLOSE_SL" ||
      ev.type === "POSITION_FORCE_CLOSE";

    if (isClose && ev.symbol && ev.payload) {
      const st = openBySymbol.get(ev.symbol) ?? null;

      const side = (ev.payload.side as "LONG" | "SHORT") ?? (st?.side ?? "LONG");
      const entryPrice = Number(ev.payload.entryPrice ?? st?.entryPrice);
      const closePrice = Number(ev.payload.closePrice);
      const qty = Number(ev.payload.qty ?? st?.qty);
      const pnlFromMove = Number(ev.payload.pnlFromMove ?? 0);
      const fundingAccrued = Number(ev.payload.fundingAccrued ?? 0);
      const feesPaid = Number(ev.payload.feesPaid ?? 0);
      const realizedPnl = Number(ev.payload.realizedPnl ?? 0);

      if (
        (side === "LONG" || side === "SHORT") &&
        Number.isFinite(entryPrice) &&
        Number.isFinite(closePrice) &&
        Number.isFinite(qty)
      ) {
        const openedAt = st?.openedAt ?? null;
        const holdMs = openedAt == null ? null : Math.max(0, ev.ts - openedAt);

        trades.push({
          symbol: ev.symbol,
          side,
          openedAt,
          closedAt: ev.ts,
          entryPrice,
          closePrice,
          qty,
          closeType: ev.type === "POSITION_CLOSE_TP" ? "TP" : ev.type === "POSITION_CLOSE_SL" ? "SL" : "FORCE",
          pnlFromMove,
          fundingAccrued,
          feesPaid,
          realizedPnl,
          holdMs
        });
      }

      openBySymbol.delete(ev.symbol);
    }
  }

  // aggregates
  const netRealized = trades.reduce((a, t) => a + (Number.isFinite(t.realizedPnl) ? t.realizedPnl : 0), 0);
  const grossFromMove = trades.reduce((a, t) => a + (Number.isFinite(t.pnlFromMove) ? t.pnlFromMove : 0), 0);
  const funding = trades.reduce((a, t) => a + (Number.isFinite(t.fundingAccrued) ? t.fundingAccrued : 0), 0);
  const fees = trades.reduce((a, t) => a + (Number.isFinite(t.feesPaid) ? t.feesPaid : 0), 0);

  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  const losses = trades.filter((t) => t.realizedPnl <= 0).length;
  const total = trades.length;
  const winRate = total ? wins / total : null;

  const winsArr = trades.filter((t) => t.realizedPnl > 0).map((t) => t.realizedPnl);
  const lossArr = trades.filter((t) => t.realizedPnl <= 0).map((t) => t.realizedPnl);

  const avgWin = mean(winsArr);
  const avgLoss = mean(lossArr);

  const expectancy =
    winRate == null || avgWin == null || avgLoss == null ? null : winRate * avgWin + (1 - winRate) * avgLoss;

  const holds = trades.map((t) => (t.holdMs == null ? null : t.holdMs / 1000)).filter((x): x is number => x != null);
  const avgHoldSec = mean(holds);

  // equity and drawdown
  let eq = 0;
  let peak = 0;
  let trough = 0;
  let maxDd = 0;

  for (const t of trades) {
    eq += t.realizedPnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const perSymbolMap = new Map<string, { trades: number; wins: number; losses: number; net: number }>();
  for (const t of trades) {
    const cur = perSymbolMap.get(t.symbol) ?? { trades: 0, wins: 0, losses: 0, net: 0 };
    cur.trades += 1;
    if (t.realizedPnl > 0) cur.wins += 1;
    else cur.losses += 1;
    cur.net += t.realizedPnl;
    perSymbolMap.set(t.symbol, cur);
  }

  const perSymbol = Array.from(perSymbolMap.entries())
    .map(([symbol, v]) => ({
      symbol,
      trades: v.trades,
      wins: v.wins,
      losses: v.losses,
      winRate: v.trades ? v.wins / v.trades : null,
      netRealized: v.net
    }))
    .sort((a, b) => Math.abs(b.netRealized) - Math.abs(a.netRealized));

  const summary: PaperSummary = {
    generatedAt: Date.now(),
    sessionId,
    startTs,
    endTs,
    durationSec: startTs != null && endTs != null ? Math.max(0, (endTs - startTs) / 1000) : null,
    trades: {
      total,
      wins,
      losses,
      winRate: winRate == null ? null : round(winRate, 6),
      avgWin: avgWin == null ? null : round(avgWin, 8),
      avgLoss: avgLoss == null ? null : round(avgLoss, 8),
      expectancy: expectancy == null ? null : round(expectancy, 8),
      avgHoldSec: avgHoldSec == null ? null : round(avgHoldSec, 2)
    },
    pnl: {
      netRealized: round(netRealized, 8),
      grossFromMove: round(grossFromMove, 8),
      funding: round(funding, 8),
      fees: round(fees, 8)
    },
    equity: {
      maxDrawdown: trades.length ? round(maxDd, 8) : null,
      peak: round(peak, 8),
      trough: round(trough, 8)
    },
    perSymbol
  };

  return { summary, trades };
}

export function getSummaryFilePathFromEventsFile(eventsFile: string): string {
  const dir = path.dirname(eventsFile);
  return path.join(dir, "summary.json");
}

export function persistSummaryFile(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");

  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }

  fs.renameSync(tmp, filePath);
}
