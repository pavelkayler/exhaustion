export type FundingCooldownState = {
  active: boolean;
  windowStartMs: number;
  windowEndMs: number;
  msToStart: number; // <0 если уже в окне/после
  msToEnd: number;   // <0 если окно прошло
};

export class FundingCooldownGate {
  private readonly beforeMs: number;
  private readonly afterMs: number;

  constructor(beforeMin: number, afterMin: number) {
    this.beforeMs = Math.max(0, beforeMin) * 60_000;
    this.afterMs = Math.max(0, afterMin) * 60_000;
  }

  state(nextFundingTimeMs: number | null, nowMs: number): FundingCooldownState | null {
    if (nextFundingTimeMs == null || !Number.isFinite(nextFundingTimeMs)) return null;

    const windowStartMs = nextFundingTimeMs - this.beforeMs;
    const windowEndMs = nextFundingTimeMs + this.afterMs;

    const active = nowMs >= windowStartMs && nowMs <= windowEndMs;

    return {
      active,
      windowStartMs,
      windowEndMs,
      msToStart: windowStartMs - nowMs,
      msToEnd: windowEndMs - nowMs
    };
  }
}