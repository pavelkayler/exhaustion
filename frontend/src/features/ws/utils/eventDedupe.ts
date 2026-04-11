import type { LogEvent } from "../../../shared/types/domain";

const RECENT_SCAN_LIMIT = 256;

function readPayloadIdentity(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const row = payload as Record<string, unknown>;
  const candidates = [
    row.seq,
    row.id,
    row.orderId,
    row.tradeId,
    row.signalId,
    row.setupId,
    row.sessionId,
    row.runId,
  ];
  for (const value of candidates) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

export function stableEventKey(event: Partial<LogEvent> & { seq?: number | string }): string {
  const seqValue = Number((event as any)?.seq);
  if (Number.isFinite(seqValue) && seqValue >= 0) {
    return `seq:${Math.floor(seqValue)}`;
  }
  const ts = Number(event?.ts ?? 0) || 0;
  const type = String(event?.type ?? "");
  const symbol = String(event?.symbol ?? "");
  const payloadKey = readPayloadIdentity(event?.payload);
  return `${ts}|${type}|${symbol}|${payloadKey}`;
}

export function dedupeEvents(events: LogEvent[], limit?: number): LogEvent[] {
  const seen = new Set<string>();
  const out: LogEvent[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const key = stableEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
    if (limit != null && out.length >= limit) break;
  }
  return out.reverse();
}

export function appendEventWithDedupe(events: LogEvent[], event: LogEvent, maxSize: number): LogEvent[] {
  const key = stableEventKey(event);
  const scanStart = Math.max(0, events.length - RECENT_SCAN_LIMIT);
  for (let i = events.length - 1; i >= scanStart; i -= 1) {
    if (stableEventKey(events[i]) === key) return events;
  }
  const next = events.length >= maxSize ? events.slice(events.length - maxSize + 1) : events.slice();
  next.push(event);
  return next;
}
