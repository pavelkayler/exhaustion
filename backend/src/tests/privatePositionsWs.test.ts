import { describe, expect, it } from "vitest";
import {
  selectEntryQtyWithinTolerance,
  shouldPlaceFirstShortEntryAsMarket,
} from "../api/privatePositionsWs.js";

describe("private execution first entry order type", () => {
  it("uses market only for the first entry when offset is zero or below", () => {
    expect(shouldPlaceFirstShortEntryAsMarket(0, 0)).toBe(true);
    expect(shouldPlaceFirstShortEntryAsMarket(0, -1)).toBe(true);
  });

  it("keeps the first entry limit when offset is above zero", () => {
    expect(shouldPlaceFirstShortEntryAsMarket(0, 0.01)).toBe(false);
  });

  it("never switches grid follow-up orders to market", () => {
    expect(shouldPlaceFirstShortEntryAsMarket(1, 0)).toBe(false);
    expect(shouldPlaceFirstShortEntryAsMarket(2, 0)).toBe(false);
  });
});

describe("private execution qty selection with small overspend tolerance", () => {
  it("rounds up when the next qty step stays within tolerance", () => {
    const qty = selectEntryQtyWithinTolerance({
      targetNotional: 100,
      price: 25.43189,
      qtyStep: 1,
    });

    expect(qty).toBe(4);
  });

  it("keeps rounded down qty when the next step would overspend too much", () => {
    const qty = selectEntryQtyWithinTolerance({
      targetNotional: 100,
      price: 27.97508,
      qtyStep: 1,
    });

    expect(qty).toBe(3);
  });
});
