export type LinearInstrumentMeta = {
  symbol: string;
  qtyStep: number;
  minOrderQty: number;
  minNotionalValue: number | null;
  tickSize: number;
  maxLeverage: number | null;
};

export function decimalsFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 6;
  const asFixed = step.toFixed(12).replace(/0+$/, "");
  const idx = asFixed.indexOf(".");
  return idx >= 0 ? asFixed.length - idx - 1 : 0;
}

export function roundDownToStep(x: number, step: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(step) || step <= 0) return x;
  const units = Math.floor((x + Number.EPSILON) / step);
  return units * step;
}

export function roundUpToStep(x: number, step: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(step) || step <= 0) return x;
  const units = Math.ceil((x - Number.EPSILON) / step);
  return units * step;
}

export function formatToDecimals(x: number, decimals: number): string {
  if (!Number.isFinite(x)) return "0";
  return x.toLocaleString("en-US", {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, decimals),
  });
}

export function pickLinearMeta(rawInstrument: any): LinearInstrumentMeta | null {
  const symbol = String(rawInstrument?.symbol ?? "");
  const qtyStep = Number(rawInstrument?.lotSizeFilter?.qtyStep);
  const minOrderQty = Number(rawInstrument?.lotSizeFilter?.minOrderQty);
  const minNotionalValueRaw = Number(rawInstrument?.lotSizeFilter?.minNotionalValue);
  const minNotionalValue = Number.isFinite(minNotionalValueRaw) && minNotionalValueRaw > 0 ? minNotionalValueRaw : null;
  const tickSize = Number(rawInstrument?.priceFilter?.tickSize);
  const maxLeverageRaw = Number(rawInstrument?.leverageFilter?.maxLeverage);
  const maxLeverage = Number.isFinite(maxLeverageRaw) && maxLeverageRaw > 0 ? maxLeverageRaw : null;
  if (!symbol || !Number.isFinite(qtyStep) || qtyStep <= 0 || !Number.isFinite(minOrderQty) || minOrderQty <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) {
    return null;
  }
  return { symbol, qtyStep, minOrderQty, minNotionalValue, tickSize, maxLeverage };
}
