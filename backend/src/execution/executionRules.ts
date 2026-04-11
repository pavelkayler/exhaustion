import type { PaperExecutionModel, PaperSide, PaperTickOhlc } from "../paper/PaperBroker.js";

export type ExecutionTieBreakRule = "worstCase";

export function evaluateLimitFill(args: {
  ohlc: PaperTickOhlc | null;
  markPrice: number;
  limitPrice: number;
  side: PaperSide;
  mode: PaperExecutionModel;
}): boolean {
  const { ohlc, markPrice, limitPrice, side, mode } = args;
  if (mode === "conservativeOhlc" && ohlc) {
    return side === "LONG" ? ohlc.low <= limitPrice : ohlc.high >= limitPrice;
  }
  return side === "LONG" ? markPrice <= limitPrice : markPrice >= limitPrice;
}

export function evaluateTpSl(args: {
  ohlc: PaperTickOhlc | null;
  markPrice: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  side: PaperSide;
  mode: PaperExecutionModel;
  tieBreakRule?: ExecutionTieBreakRule;
}): { closeType: "TP" | "SL" | null; closePrice: number | null } {
  const { ohlc, markPrice, tpPrice, slPrice, side, mode, tieBreakRule = "worstCase" } = args;

  if (mode === "conservativeOhlc" && ohlc) {
    const tpHit = side === "LONG" ? ohlc.high >= tpPrice : ohlc.low <= tpPrice;
    const slHit = side === "LONG" ? ohlc.low <= slPrice : ohlc.high >= slPrice;
    if (tpHit && slHit) {
      if (tieBreakRule === "worstCase") return { closeType: "SL", closePrice: slPrice };
    }
    if (slHit) return { closeType: "SL", closePrice: slPrice };
    if (tpHit) return { closeType: "TP", closePrice: tpPrice };
    return { closeType: null, closePrice: null };
  }

  if (side === "LONG") {
    if (markPrice >= tpPrice) return { closeType: "TP", closePrice: tpPrice };
    if (markPrice <= slPrice) return { closeType: "SL", closePrice: slPrice };
    return { closeType: null, closePrice: null };
  }

  if (markPrice <= tpPrice) return { closeType: "TP", closePrice: tpPrice };
  if (markPrice >= slPrice) return { closeType: "SL", closePrice: slPrice };
  return { closeType: null, closePrice: null };
}
