import { useEffect, useMemo, useState } from "react";
import { Card, Col, Container, Form, Row, Table } from "react-bootstrap";
import { HeaderBar } from "../dashboard/components/HeaderBar";
import { useSessionRuntime } from "../../features/session/hooks/useSessionRuntime";
import { resetRuntimeArtifacts } from "../../features/session/api/sessionApi";
import { useWsFeed } from "../../features/ws/hooks/useWsFeed";
import type {
  LogEvent,
  SignalPreset,
  SignalThresholds,
  ShortOiSpikeWatchlistRecord,
  SymbolRow,
} from "../../shared/types/domain";
import { formatCompactNumber } from "./formatCompactNumber";
import {
  applySignalPreset,
  deleteSignalPreset,
  fetchSignalPresets,
  saveSignalPreset,
} from "./api/signalPresetsApi";
import { SignalPresetEditorCard } from "./SignalPresetEditorCard";

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
  return (
    isRejectedState(payload?.nextState) ||
    isRejectedState(payload?.state) ||
    isRejectedState(snapshot?.state)
  );
}

function eventSummary(event: LogEvent): string {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  return String(
    payload?.summaryReason ?? payload?.reason ?? payload?.transitionReason ?? "-",
  );
}

function buildCoinGlassUrl(symbol: string): string {
  return `https://www.coinglass.com/tv/Bybit_${encodeURIComponent(symbol)}`;
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
  const { status, busy, start, stop, pause, resume, canStart, canStop, canPause, canResume } =
    useSessionRuntime();
  const [hideRejected, setHideRejected] = useState(false);
  const [presetLoading, setPresetLoading] = useState(true);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetBusyAction, setPresetBusyAction] = useState<"none" | "save" | "delete" | "apply">("none");
  const [resetBusy, setResetBusy] = useState(false);
  const [presets, setPresets] = useState<SignalPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [draftThresholds, setDraftThresholds] = useState<SignalThresholds | null>(null);

  useEffect(() => {
    requestEventsTail(100);
  }, [requestEventsTail]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setPresetLoading(true);
      setPresetError(null);
      try {
        const response = await fetchSignalPresets();
        if (!active) return;
        setPresets(response.presets);
        setSelectedPresetId(response.selectedPresetId ?? response.presets[0]?.id ?? null);
        setDraftThresholds(response.currentThresholds);
        const selectedPreset = response.presets.find((preset) => preset.id === response.selectedPresetId) ?? null;
        setPresetName(selectedPreset?.name ?? "Custom");
      } catch (error) {
        if (!active) return;
        setPresetError(String((error as Error)?.message ?? error));
      } finally {
        if (active) setPresetLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  function applyPresetResponse(response: {
    presets: SignalPreset[];
    selectedPresetId: string | null;
    currentThresholds: SignalThresholds;
  }) {
    setPresets(response.presets);
    setSelectedPresetId(response.selectedPresetId ?? response.presets[0]?.id ?? null);
    setDraftThresholds(response.currentThresholds);
    const selectedPreset = response.presets.find((preset) => preset.id === response.selectedPresetId) ?? null;
    setPresetName(selectedPreset?.name ?? presetName);
  }

  const handlePresetSelect = (presetId: string) => {
    const selectedPreset = presets.find((preset) => preset.id === presetId) ?? null;
    setSelectedPresetId(selectedPreset?.id ?? null);
    setPresetName(selectedPreset?.name ?? "");
    setDraftThresholds(selectedPreset ? structuredClone(selectedPreset.thresholds) : draftThresholds);
  };

  const handleThresholdChange = (
    section: keyof SignalThresholds,
    field: string,
    value: number | boolean | null,
  ) => {
    setDraftThresholds((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as SignalThresholds & Record<string, unknown>;
      const sectionState = next[section] as Record<string, unknown>;
      sectionState[field] = value;
      return next;
    });
  };

  const handleSavePreset = async () => {
    if (!draftThresholds) return;
    const trimmedName = presetName.trim();
    if (!trimmedName) {
      setPresetError("Preset name is required.");
      return;
    }

    setPresetBusyAction("save");
    setPresetError(null);
    try {
      const canOverwrite = selectedPresetId != null && selectedPresetId !== "default";
      const response = await saveSignalPreset({
        id: canOverwrite ? selectedPresetId : null,
        name: trimmedName,
        thresholds: draftThresholds,
      });
      setPresets(response.presets);
      const savedPreset = response.savedPreset ?? null;
      setSelectedPresetId(savedPreset?.id ?? selectedPresetId);
      setPresetName(savedPreset?.name ?? trimmedName);
    } catch (error) {
      setPresetError(String((error as Error)?.message ?? error));
    } finally {
      setPresetBusyAction("none");
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPresetId || selectedPresetId === "default") return;
    setPresetBusyAction("delete");
    setPresetError(null);
    try {
      const response = await deleteSignalPreset(selectedPresetId);
      applyPresetResponse(response);
      const nextSelected = response.presets.find((preset) => preset.id === response.selectedPresetId)
        ?? response.presets.find((preset) => preset.id === "default")
        ?? null;
      setPresetName(nextSelected?.name ?? "Default");
    } catch (error) {
      setPresetError(String((error as Error)?.message ?? error));
    } finally {
      setPresetBusyAction("none");
    }
  };

  const handleApplyPreset = async () => {
    if (!draftThresholds) return;
    setPresetBusyAction("apply");
    setPresetError(null);
    try {
      const response = await applySignalPreset({
        selectedPresetId,
        thresholds: draftThresholds,
      });
      applyPresetResponse(response);
    } catch (error) {
      setPresetError(String((error as Error)?.message ?? error));
    } finally {
      setPresetBusyAction("none");
    }
  };

  const handleReset = async () => {
    if (resetBusy) return;
    setResetBusy(true);
    try {
      await resetRuntimeArtifacts();
    } finally {
      setResetBusy(false);
    }
  };

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
        .filter((row) => !hideRejected || !isRejectedState(row.shortSignalState))
        .slice()
        .sort(
          (left, right) =>
            Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0),
        )
        .slice(0, 10),
    [hideRejected, rows],
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
      .filter((row) => !hideRejected || !isRejectedState(row.shortSignalState))
      .sort((left, right) => {
        const delta =
          Math.abs(Number(right.oiMove5mPct ?? 0)) -
          Math.abs(Number(left.oiMove5mPct ?? 0));
        if (delta !== 0) return delta;
        return left.symbol.localeCompare(right.symbol);
      })
      .slice(0, 10);
  }, [hideRejected, rows, signalEventCountBySymbol]);

  const recentEvents = useMemo(
    () =>
      [...events, ...eventStream]
        .filter((event) => SHORT_SIGNAL_EVENT_TYPES.has(normalizeState(event.type)))
        .filter((event) => !hideRejected || !isRejectedShortEvent(event))
        .sort((left, right) => Number(right.ts ?? 0) - Number(left.ts ?? 0))
        .filter(
          (event, index, arr) =>
            arr.findIndex(
              (candidate) =>
                candidate.ts === event.ts &&
                candidate.type === event.type &&
                candidate.symbol === event.symbol,
            ) === index,
        )
        .slice(0, 10),
    [eventStream, events, hideRejected],
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
        canReset={!resetBusy}
        resetBusy={resetBusy}
        onReset={() => void handleReset()}
      />
      <Container fluid className="py-3 px-2">
        <Card className="genesis-card mb-3">
          <Card.Body className="py-2 px-3 d-flex align-items-center justify-content-end">
            <Form.Check
              type="checkbox"
              id="short-signals-hide-rejected-global"
              label="hide rejected"
              checked={hideRejected}
              onChange={(event) => setHideRejected(event.currentTarget.checked)}
              className="mb-0 user-select-none"
            />
          </Card.Body>
        </Card>

        <Row className="g-3">
          <Col xs={12}>
            <SignalPresetEditorCard
              presets={presets}
              selectedPresetId={selectedPresetId}
              presetName={presetName}
              thresholds={draftThresholds}
              loading={presetLoading}
              busyAction={presetBusyAction}
              error={presetError}
              onPresetSelect={handlePresetSelect}
              onPresetNameChange={setPresetName}
              onThresholdChange={handleThresholdChange}
              onSave={() => void handleSavePreset()}
              onDelete={() => void handleDeletePreset()}
              onApply={() => void handleApplyPreset()}
            />
          </Col>

          <Col xl={6}>
            <Card className="genesis-card h-100">
              <Card.Header>Recent Signals</Card.Header>
              <Card.Body className="p-0">
                <Table
                  responsive
                  hover
                  className="mb-0"
                  style={{ tableLayout: "fixed", fontSize: TABLE_FONT_SIZE }}
                >
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
                        <td colSpan={5} className="text-center text-secondary py-4">
                          No recent short signals.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </Table>
              </Card.Body>
            </Card>
          </Col>

          <Col xl={6}>
            <Card className="genesis-card h-100">
              <Card.Header>Top OI Watchlist</Card.Header>
              <Card.Body className="p-0">
                <Table
                  responsive
                  hover
                  className="mb-0"
                  style={{ tableLayout: "fixed", fontSize: TABLE_FONT_SIZE }}
                >
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
                        <td colSpan={5} className="text-center text-secondary py-4">
                          No OI watchlist data.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </Table>
              </Card.Body>
            </Card>
          </Col>

          <Col xs={12}>
            <Card className="genesis-card">
              <Card.Header>Recent Signal Events</Card.Header>
              <Card.Body className="p-0">
                <Table
                  responsive
                  hover
                  className="mb-0"
                  style={{ tableLayout: "fixed", fontSize: TABLE_FONT_SIZE }}
                >
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
                      <tr
                        key={`${String(event.ts ?? "0")}:${String(
                          event.type ?? "unknown",
                        )}:${String(event.symbol ?? "")}:${index}`}
                      >
                        <td>{formatTime(finite(event.ts))}</td>
                        <td>{String(event.symbol ?? "-")}</td>
                        <td>{String(event.type ?? "-")}</td>
                        <td>{eventSummary(event)}</td>
                      </tr>
                    ))}
                    {recentEvents.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center text-secondary py-4">
                          No recent signal events.
                        </td>
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
