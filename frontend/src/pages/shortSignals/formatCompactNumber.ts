export function formatCompactNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "-";

  const numeric = Number(value);
  const abs = Math.abs(numeric);
  const units = [
    { threshold: 1_000_000_000_000, suffix: "t" },
    { threshold: 1_000_000_000, suffix: "b" },
    { threshold: 1_000_000, suffix: "m" },
    { threshold: 1_000, suffix: "k" },
  ] as const;

  for (const unit of units) {
    if (abs < unit.threshold) continue;
    const scaled = numeric / unit.threshold;
    return `${Number(scaled.toFixed(1)).toString()}${unit.suffix}`;
  }

  return `${Math.round(numeric)}`;
}
