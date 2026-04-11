import { useEffect, useMemo, useState } from "react";
import { Card, Col, Container, Form, Row, Table } from "react-bootstrap";
import { HeaderBar } from "../dashboard/components/HeaderBar";
import { useSessionRuntime } from "../../features/session/hooks/useSessionRuntime";
import { useWsFeed } from "../../features/ws/hooks/useWsFeed";
import type { LogEvent, ShortOiSpikeWatchlistRecord, SymbolRow } from "../../shared/types/domain";
import { formatCompactNumber } from "./formatCompactNumber";

const SHORT_SIGNAL_EVENT_TYPES = new Set([
  "SHORT_SIGNAL_STAGE",
  "SHORT_SIGNAL_TRANSITION",
  "SHORT_SIGNAL_TRIGGER",
]);

const TABLE_FONT_SIZE = "0.875rem";

function finite(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return "-";
  return Number(value).toFixed(digits);
}

function formatPercent(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return "-";
  return `${Number(value).toFixed(digits)}%`;
}

function formatTime(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "-";
  return new Date(Number(value)).toLocaleTimeString();
}

function normalizeState(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function isRejectedState(value: unknown): boolean {
  return normalizeState(value) === "REJECTED";
}

function isActiveShortSignalRow(row: SymbolRow): boolean {
  const state = normalizeState(row.shortSignalState);
  return state !== "" && state !== "IDLE" && state !== "EXPIRED";
}

function isRejectedShortEvent(event: LogEvent): boolean {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  const snapshot = payload?.snapshot as Record<string, unknown> | null | undefined;
  return isRejectedState(payload?.nextState)
    || isRejectedState(payload?.state)
    || isRejectedState(snapshot?.state);
}

function eventSummary(event: LogEvent): string {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  return String(payload?.summaryReason ?? payload?.reason ?? payload?.transitionReason ?? "-");
}

function buildCoinGlassUrl(symbol: string): string {
  return `https://www.coinglass.com/tv/Bybit_${encodeURIComponent(symbol)}`;
}

function BlockHeader(props: {
  title: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
      <span>{props.title}</span>
      <Form.Check
        type="checkbox"
        id={`hide-rejected-${props.title.replace(/\s+/g, "-").toLowerCase()}`}
        label="hide rejected"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
        className="mb-0 user-select-none"
      />
    </div>
  );
}

export function ShortSignalsPage() {
  const {
    conn,
    lastServerTime,
    wsUrl,
    streams,
    rows,
    events,
    eventStream,
    requestEventsTail,
  } = useWsFeed();
  const { status, busy, start, stop, pause, resume, canStart, canStop, canPause, canResume } = useSessionRuntime();
  const [recentSignalsHideRejected, setRecentSignalsHideRejected] = useState(false);
  const [watchlistHideRejected, setWatchlistHideRejected] = useState(false);
  const [recentEventsHideRejected, setRecentEventsHideRejected] = useState(false);

  useEffect(() => {
    requestEventsTail(100);
  }, [requestEventsTail]);

  const signalEventCountBySymbol = useMemo(() => {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const event of [...events, ...eventStream]) {
      const type = normalizeState(event.type);
      const symbol = String(event.symbol ?? "").trim().toUpperCase();
      if (!SHORT_SIGNAL_EVENT_TYPES.has(type) || !symbol) continue;
      const key = `${String(event.ts ?? "")}:${type}:${symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    return counts;
  }, [eventStream, events]);

  const recentSignals = useMemo(
    () =>
      rows
        .filter(isActiveShortSignalRow)
        .filter((row) => !recentSignalsHideRejected || !isRejectedState(row.shortSignalState))
        .slice()
        .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
        .slice(0, 10),
    [recentSignalsHideRejected, rows],
  );

  const filteredWatchlist = useMemo(() => {
    return rows
      .filter((row) => Number.isFinite(row.shortOiMove5mPct as number))
      .map<ShortOiSpikeWatchlistRecord>((row) => ({
        symbol: row.symbol,
        turnover24hUsd: finite(row.turnover24hUsd),
        oiMove5mPct: finite(row.shortOiMove5mPct),
        oiMove15mPct: finite(row.shortOiMove15mPct),
        oiMove1hPct: finite(row.shortOiMove1hPct),
        shortSignalState: row.shortSignalState ?? null,
        shortSignalStage: row.shortSignalStage ?? null,
        shortTotalScore: finite(row.shortTotalScore),
        shortSummaryReason: row.shortSummaryReason ?? null,
        signalOrdinal: Number(signalEventCountBySymbol.get(row.symbol) ?? 0),
        coinglassUrl: buildCoinGlassUrl(row.symbol),
      }))
      .filter((row) => !watchlistHideRejected || !isRejectedState(row.shortSignalState))
      .sort((left, right) => {
        const delta = Math.abs(Number(right.oiMove5mPct ?? 0)) - Math.abs(Number(left.oiMove5mPct ?? 0));
        if (delta !== 0) return delta;
        return left.symbol.localeCompare(right.symbol);
      })
      .slice(0, 10);
  }, [rows, signalEventCountBySymbol, watchlistHideRejected]);

  const recentEvents = useMemo(
    () =>
      [...events, ...eventStream]
        .filter((event) => SHORT_SIGNAL_EVENT_TYPES.has(normalizeState(event.type)))
        .filter((event) => !recentEventsHideRejected || !isRejectedShortEvent(event))
        .sort((left, right) => Number(right.ts ?? 0) - Number(left.ts ?? 0))
        .filter((event, index, arr) => arr.findIndex((candidate) =>
          candidate.ts === event.ts
          && candidate.type === event.type
          && candidate.symbol === event.symbol
        ) === index)
        .slice(0, 10),
    [eventStream, events, recentEventsHideRejected],
  );

  return (
    <>
      <HeaderBar
        conn={conn}
        sessionState={status.sessionState}
        runningBotName={status.runningBotName}
        wsUrl={wsUrl}
        lastServerTime={lastServerTime}
        streams={streams}
        canStart={canStart}
        canStop={canStop}
        canPause={canPause}
        canResume={canResume}
        busy={busy}
        onStart={() => void start()}
        onStop={() => void stop()}
        onPause={() => void pause()}
        onResume={() => void resume()}
      />
      <Container fluid className="py-3 px-2">
        <Row className="g-3">
          <Col xl={6}>
            <Card className="genesis-card h-100">
              <Card.Header>
                <BlockHeader
                  title="Recent Signals"
                  checked={recentSignalsHideRejected}
                  onChange={setRecentSignalsHideRejected}
                />
              </Card.Header>
              <Card.Body className="p-0">
                <Table responsive hover className="mb-0" style={{ tableLayout: "fixed", fontSize: TABLE_FONT_SIZE }}>
                  <colgroup>
                    <col style={{ width: "120px" }} />
                    <col style={{ width: "130px" }} />
                    <col style={{ width: "130px" }} />
                    <col style={{ width: "90px" }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Symbol</th>
                      <th>State</th>
                      <th>Total</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentSignals.map((row) => (
                      <tr key={`${row.symbol}:${String(row.updatedAt ?? "0")}`}>
                        <td>{formatTime(finite(row.updatedAt))}</td>
                        <td>{row.symbol}</td>
                        <td>{row.shortSignalState ?? "-"}</td>
                        <td>{formatNumber(finite(row.shortTotalScore), 2)}</td>
                        <td>{row.shortSummaryReason ?? "-"}</td>
                      </tr>
                    ))}
                    {recentSignals.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-secondary py-4">No recent short signals.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </Table>
              </Card.Body>
            </Card>
          </Col>
          <Col xl={6}>
            <Card className="genesis-card h-100">
              <Card.Header>
                <BlockHeader
                  title="Top OI Watchlist"
                  checked={watchlistHideRejected}
                  onChange={setWatchlistHideRejected}
                />
              </Card.Header>
              <Card.Body className="p-0">
                <Table responsive hover className="mb-0" style={{ tableLayout: "fixed", fontSize: TABLE_FONT_SIZE }}>
                  <colgroup>
                    <col style={{ width: "190px" }} />
                    <col style={{ width: "160px" }} />
                    <col style={{ width: "110px" }} />
                    <col style={{ width: "120px" }} />
                    <col style={{ width: "100px" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Turnover 24h</th>
                      <th>OI 5m</th>
                      <th>State</th>
                      <th>Signal #</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWatchlist.map((row) => (
                      <tr key={row.symbol}>
                        <td>{row.symbol}</td>
                        <td>{formatCompactNumber(finite(row.turnover24hUsd))}</td>
                        <td>{formatPercent(finite(row.oiMove5mPct), 3)}</td>
                        <td>{row.shortSignalState ?? "-"}</td>
                        <td>{row.signalOrdinal}</td>
                      </tr>
                    ))}
                    {filteredWatchlist.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-secondary py-4">No OI watchlist data.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </Table>
              </Card.Body>
            </Card>
          </Col>
          <Col xs={12}>
            <Card className="genesis-card">
              <Card.Header>
                <BlockHeader
                  title="Recent Signal Events"
                  checked={recentEventsHideRejected}
                  onChange={setRecentEventsHideRejected}
                />
              </Card.Header>
              <Card.Body className="p-0">
                <Table responsive hover className="mb-0" style={{ tableLayout: "fixed", fontSize: TABLE_FONT_SIZE }}>
                  <colgroup>
                    <col style={{ width: "130px" }} />
                    <col style={{ width: "120px" }} />
                    <col style={{ width: "250px" }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentEvents.map((event, index) => (
                      <tr key={`${String(event.ts ?? "0")}:${String(event.type ?? "unknown")}:${String(event.symbol ?? "")}:${index}`}>
                        <td>{formatTime(finite(event.ts))}</td>
                        <td>{String(event.symbol ?? "-")}</td>
                        <td>{String(event.type ?? "-")}</td>
                        <td>{eventSummary(event)}</td>
                      </tr>
                    ))}
                    {recentEvents.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center text-secondary py-4">No recent signal events.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </Table>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Container>
    </>
  );
}
