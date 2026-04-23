import { describe, expect, it } from "vitest";
import {
  resolveDemoCloseType,
  resolveDemoReconcileCloseState,
} from "../demo/demoCloseUtils.js";

describe("demo close classification", () => {
  it("classifies short take-profit closes as TP", () => {
    expect(resolveDemoCloseType({
      side: "SHORT",
      exitPrice: 1.22333,
      tpPrice: 1.22394,
      slPrice: 1.71781,
    })).toBe("TP");
  });

  it("classifies short stop-loss closes as SL", () => {
    expect(resolveDemoCloseType({
      side: "SHORT",
      exitPrice: 1.455,
      tpPrice: 1.35,
      slPrice: 1.452,
    })).toBe("SL");
  });

  it("falls back to FORCE when neither protection level matches", () => {
    expect(resolveDemoCloseType({
      side: "SHORT",
      exitPrice: 1.31,
      tpPrice: 1.22,
      slPrice: 1.46,
    })).toBe("FORCE");
  });
});

describe("demo reconcile close confirmation", () => {
  it("does not confirm close on the first missing snapshot", () => {
    expect(resolveDemoReconcileCloseState({
      positionOpen: true,
      serverPositionsCount: 0,
      missingSinceMs: null,
      nowMs: 10_000,
    })).toEqual({
      confirmed: false,
      nextMissingSinceMs: 10_000,
    });
  });

  it("confirms close only after the grace window elapses", () => {
    expect(resolveDemoReconcileCloseState({
      positionOpen: true,
      serverPositionsCount: 0,
      missingSinceMs: 10_000,
      nowMs: 16_000,
    })).toEqual({
      confirmed: true,
      nextMissingSinceMs: 10_000,
    });
  });

  it("clears pending close tracking when the position reappears", () => {
    expect(resolveDemoReconcileCloseState({
      positionOpen: true,
      serverPositionsCount: 1,
      missingSinceMs: 10_000,
      nowMs: 10_500,
    })).toEqual({
      confirmed: false,
      nextMissingSinceMs: null,
    });
  });
});
