const HARD_EXCLUDED_SHORT_SYMBOLS = new Set([
  "USDCUSDT",
  "XAUTUSDT",
  "PAXGUSDT",
  "XAUUSDT",
  "XAGUSDT",
]);

const HARD_EXCLUDED_SHORT_BASE_PATTERNS = [
  /^USDC$/,
  /^XAUT$/,
  /^PAXG$/,
  /^XAU$/,
  /^XAG$/,
  /GOLD/,
  /SILV/,
  /SILVER/,
];

function normalizeSymbol(symbol: unknown): string {
  return String(symbol ?? "").trim().toUpperCase();
}

function baseAsset(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

export function isHardExcludedShortSymbol(symbol: unknown): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (HARD_EXCLUDED_SHORT_SYMBOLS.has(normalized)) return true;
  const base = baseAsset(normalized);
  return HARD_EXCLUDED_SHORT_BASE_PATTERNS.some((pattern) => pattern.test(base));
}

export function filterTradableShortSymbols(symbols: unknown[]): string[] {
  const unique = new Set<string>();
  for (const symbol of symbols) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || isHardExcludedShortSymbol(normalized)) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

export function getHardExcludedShortSymbols(): string[] {
  return Array.from(HARD_EXCLUDED_SHORT_SYMBOLS.values());
}
