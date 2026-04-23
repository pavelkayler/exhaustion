import type { PaperSide } from "../paper/PaperBroker.js";

export type DemoCloseType = "TP" | "SL" | "FORCE";

const DEFAULT_CLOSE_CONFIRM_MS = 5_000;

function finite(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sameWithinTolerance(left: number, right: number): boolean {
  const tolerance = Math.max(Math.abs(right) * 0.003, 1e-8);
  return Math.abs(left - right) <= tolerance;
}

export function resolveDemoCloseType(args: {
  side: PaperSide | null;
  exitPrice: number | null;
  tpPrice: number | null;
  slPrice: number | null;
}): DemoCloseType {
  const side = args.side;
  const exitPrice = finite(args.exitPrice);
  const tpPrice = finite(args.tpPrice);
  const slPrice = finite(args.slPrice);
  if (!side || !(exitPrice && exitPrice > 0)) return "FORCE";

  const tpHit = tpPrice != null && tpPrice > 0 && (
    sameWithinTolerance(exitPrice, tpPrice)
    || (side === "SHORT" ? exitPrice <= tpPrice : exitPrice >= tpPrice)
  );
  const slHit = slPrice != null && slPrice > 0 && (
    sameWithinTolerance(exitPrice, slPrice)
    || (side === "SHORT" ? exitPrice >= slPrice : exitPrice <= slPrice)
  );

  if (tpHit && slHit && tpPrice != null && slPrice != null) {
    return Math.abs(exitPrice - tpPrice) <= Math.abs(exitPrice - slPrice) ? "TP" : "SL";
  }
  if (tpHit) return "TP";
  if (slHit) return "SL";
  return "FORCE";
}

export function resolveDemoReconcileCloseState(args: {
  positionOpen: boolean;
  serverPositionsCount: number;
  missingSinceMs: number | null;
  nowMs: number;
  confirmMs?: number;
}): {
  confirmed: boolean;
  nextMissingSinceMs: number | null;
} {
  if (!args.positionOpen || args.serverPositionsCount > 0) {
    return {
      confirmed: false,
      nextMissingSinceMs: null,
    };
  }

  const missingSinceMs = args.missingSinceMs ?? args.nowMs;
  const confirmMs = Math.max(0, Math.floor(Number(args.confirmMs) || DEFAULT_CLOSE_CONFIRM_MS));
  return {
    confirmed: (args.nowMs - missingSinceMs) >= confirmMs,
    nextMissingSinceMs: missingSinceMs,
  };
}
