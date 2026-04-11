export function fmtNum(n: number) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

export function fmtMoney(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(4);
}

export function formatFee(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "-";
  return `-${Math.abs(n).toFixed(4)}`;
}

export function fmtPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n.toFixed(3)}%`;
}

export function fmtTime(ms: number | null | undefined) {
  if (!ms || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleTimeString();
}

export function fmtDateTime(ms: number | null | undefined) {
  if (!ms || !Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}
