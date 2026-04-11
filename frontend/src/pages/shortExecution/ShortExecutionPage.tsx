import { useMemo } from "react";
import { Badge, Card, Col, Container, Form, Row, Table } from "react-bootstrap";
import { HeaderBar } from "../dashboard/components/HeaderBar";
import { useSessionRuntime } from "../../features/session/hooks/useSessionRuntime";
import { useWsFeed } from "../../features/ws/hooks/useWsFeed";
import { usePersistentState } from "../../shared/hooks/usePersistentState";
import {
  usePrivatePositionsFeed,
  type ExecutionPositionReason,
  type ExecutionPositionRow,
} from "../../features/positions/hooks/usePrivatePositionsFeed";

type ExecutorLocalSettings = {
  mode: "demo" | "real";
  maxUsdt: number;
  leverage: number;
  tpPct: number;
  slPct: number;
  firstOrderOffsetPct: number;
  gridOrdersCount: number;
  gridStepPct: number;
  staleSec: number;
  cooldownMin: number;
  trackCandidateSignalsForResearch: boolean;
  takeCandidateSignalsInLiveExecution: boolean;
  takeFinalSignals: boolean;
  cancelActivePositionOrders: boolean;
};

const DEFAULT_SETTINGS: ExecutorLocalSettings = {
  mode: "demo",
  maxUsdt: 100,
  leverage: 10,
  tpPct: 3,
  slPct: 6,
  firstOrderOffsetPct: 0.6,
  gridOrdersCount: 2,
  gridStepPct: 1.2,
  staleSec: 120,
  cooldownMin: 20,
  trackCandidateSignalsForResearch: false,
  takeCandidateSignalsInLiveExecution: true,
  takeFinalSignals: true,
  cancelActivePositionOrders: true,
};

type NumericFieldKey =
  | "maxUsdt"
  | "leverage"
  | "tpPct"
  | "slPct"
  | "firstOrderOffsetPct"
  | "gridOrdersCount"
  | "gridStepPct"
  | "staleSec"
  | "cooldownMin";

type DisplayPositionRow = ExecutionPositionRow & {
  displayValue: number | null;
  displayPnl: number | null;
  displayTpPct: number | null;
  displaySlPct: number | null;
};

function formatCurrency(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return "-";
  return `$${Number(value).toFixed(digits)}`;
}

function formatPercent(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return "-";
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(digits)}%`;
}

function formatUpdatedAt(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "-";
  return new Date(Number(value)).toLocaleTimeString();
}

function renderPositionMessage(status: string, error: string | null): string {
  if (error) return error;
  if (status === "missing_credentials") {
    return "Bybit private websocket credentials are missing in ./backend/.env.";
  }
  if (
    status === "connecting" ||
    status === "authenticating" ||
    status === "subscribing" ||
    status === "reconnecting"
  ) {
    return `Positions feed: ${status}.`;
  }
  return "No open positions.";
}

function rowVariantClass(row: { displayPnl: number | null }): string {
  if (!Number.isFinite(row.displayPnl as number) || Number(row.displayPnl) === 0) return "";
  return Number(row.displayPnl) > 0 ? "text-success" : "text-danger";
}

function normalizeReason(value: ExecutionPositionReason): string {
  return value === "candidate" ? "candidate" : value === "final" ? "final" : "manual";
}

function computeLivePnl(args: {
  side: string | null;
  size: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  fallbackPnl: number | null;
}): number | null {
  const size = Number(args.size);
  const entryPrice = Number(args.entryPrice);
  const currentPrice = Number(args.currentPrice);
  const side = String(args.side ?? "").trim().toUpperCase();

  if (!(size > 0) || !(entryPrice > 0) || !(currentPrice > 0)) {
    return args.fallbackPnl;
  }

  if (side === "SELL") {
    return (entryPrice - currentPrice) * size;
  }

  if (side === "BUY") {
    return (currentPrice - entryPrice) * size;
  }

  return args.fallbackPnl;
}

function computeTargetPct(targetPrice: number | null, entryPrice: number | null): number | null {
  const target = Number(targetPrice);
  const entry = Number(entryPrice);
  if (!(target > 0) || !(entry > 0)) return null;
  return ((target - entry) / entry) * 100;
}

export function ShortExecutionPage() {
  const { conn, lastServerTime, wsUrl, streams, rows } = useWsFeed();
  const { status, busy, start, stop, pause, resume, canStart, canStop, canPause, canResume } =
    useSessionRuntime();
  const [settings, setSettings] = usePersistentState<ExecutorLocalSettings>(
    "short-execution.local-settings",
    DEFAULT_SETTINGS,
  );
  const positionsFeed = usePrivatePositionsFeed(settings.mode);

  const marketPriceBySymbol = useMemo(() => {
    const out = new Map<string, number>();
    for (const row of rows) {
      const symbol = String(row.symbol ?? "").trim().toUpperCase();
      const markPrice = Number(row.markPrice ?? row.lastPrice ?? 0);
      if (!symbol || !(markPrice > 0)) continue;
      out.set(symbol, markPrice);
    }
    return out;
  }, [rows]);

  const displayRows = useMemo<DisplayPositionRow[]>(() => {
    return positionsFeed.rows.map((row) => {
      const currentPrice = marketPriceBySymbol.get(row.symbol) ?? row.markPrice ?? null;
      const size = Number(row.size ?? 0);
      const displayValue =
        size > 0 && Number(currentPrice) > 0
          ? size * Number(currentPrice)
          : row.value ?? null;

      return {
        ...row,
        displayValue,
        displayPnl: computeLivePnl({
          side: row.side,
          size: row.size,
          entryPrice: row.entryPrice,
          currentPrice,
          fallbackPnl: row.pnl,
        }),
        displayTpPct: computeTargetPct(row.tp, row.entryPrice),
        displaySlPct: computeTargetPct(row.sl, row.entryPrice),
      };
    });
  }, [marketPriceBySymbol, positionsFeed.rows]);

  const updateNumber = (key: NumericFieldKey, value: string) => {
    const numeric = Number(value);
    setSettings((prev) => ({
      ...prev,
      [key]: Number.isFinite(numeric) ? numeric : prev[key],
    }));
  };

  const updateBoolean = (key: keyof ExecutorLocalSettings, value: boolean) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

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
        <Card className="genesis-card mb-3">
          <Card.Body className="py-2 px-3 d-flex align-items-center justify-content-between gap-3 flex-wrap">
            <div className="fw-semibold">Execution</div>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <Badge bg={settings.mode === "real" ? "danger" : "warning"}>
                mode: {settings.mode}
              </Badge>
              <small className="text-secondary">
                positions feed: {positionsFeed.status}
              </small>
            </div>
          </Card.Body>
        </Card>

        <Row className="g-3">
          <Col xs={12}>
            <Card className="genesis-card">
              <Card.Header className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                <span>Positions</span>
                <small className="text-secondary">
                  updated: {formatUpdatedAt(positionsFeed.updatedAt)}
                </small>
              </Card.Header>
              <Card.Body className="p-0">
                <Table responsive hover className="mb-0" style={{ tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Reason</th>
                      <th>Value</th>
                      <th>PnL</th>
                      <th>TP</th>
                      <th>SL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.symbol}</td>
                        <td>{normalizeReason(row.reason)}</td>
                        <td>{formatCurrency(row.displayValue, 2)}</td>
                        <td className={rowVariantClass(row)}>{formatCurrency(row.displayPnl, 2)}</td>
                        <td>{formatPercent(row.displayTpPct, 2)}</td>
                        <td>{formatPercent(row.displaySlPct, 2)}</td>
                      </tr>
                    ))}
                    {displayRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-secondary py-4">
                          {renderPositionMessage(positionsFeed.status, positionsFeed.error)}
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
              <Card.Header className="d-flex justify-content-between align-items-center">
                <span>Execution Settings</span>
                <small className="text-secondary">Stored locally in this browser</small>
              </Card.Header>
              <Card.Body>
                <Row className="g-3">
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Mode</Form.Label>
                      <Form.Select
                        value={settings.mode}
                        onChange={(event) =>
                          setSettings((prev) => ({
                            ...prev,
                            mode: event.target.value === "real" ? "real" : "demo",
                          }))
                        }
                      >
                        <option value="demo">demo</option>
                        <option value="real">real</option>
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Max USDT</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.maxUsdt}
                        onChange={(event) => updateNumber("maxUsdt", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Leverage</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.leverage}
                        onChange={(event) => updateNumber("leverage", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>TP %</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.tpPct}
                        onChange={(event) => updateNumber("tpPct", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>SL %</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.slPct}
                        onChange={(event) => updateNumber("slPct", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>First order offset %</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.firstOrderOffsetPct}
                        onChange={(event) =>
                          updateNumber("firstOrderOffsetPct", event.target.value)
                        }
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Grid orders count</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.gridOrdersCount}
                        onChange={(event) =>
                          updateNumber("gridOrdersCount", event.target.value)
                        }
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Grid step %</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.gridStepPct}
                        onChange={(event) => updateNumber("gridStepPct", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Stale sec</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.staleSec}
                        onChange={(event) => updateNumber("staleSec", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group>
                      <Form.Label>Cooldown min</Form.Label>
                      <Form.Control
                        type="number"
                        value={settings.cooldownMin}
                        onChange={(event) => updateNumber("cooldownMin", event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                </Row>
                <div className="d-flex flex-column gap-2 mt-4">
                  <Form.Check
                    type="checkbox"
                    label="Track candidate signals for research"
                    checked={settings.trackCandidateSignalsForResearch}
                    onChange={(event) =>
                      updateBoolean(
                        "trackCandidateSignalsForResearch",
                        event.target.checked,
                      )
                    }
                  />
                  <Form.Check
                    type="checkbox"
                    label="Take candidate signals in live execution"
                    checked={settings.takeCandidateSignalsInLiveExecution}
                    onChange={(event) =>
                      updateBoolean(
                        "takeCandidateSignalsInLiveExecution",
                        event.target.checked,
                      )
                    }
                  />
                  <Form.Check
                    type="checkbox"
                    label="Take final signals"
                    checked={settings.takeFinalSignals}
                    onChange={(event) =>
                      updateBoolean("takeFinalSignals", event.target.checked)
                    }
                  />
                  <Form.Check
                    type="checkbox"
                    label="Cancel active position orders"
                    checked={settings.cancelActivePositionOrders}
                    onChange={(event) =>
                      updateBoolean(
                        "cancelActivePositionOrders",
                        event.target.checked,
                      )
                    }
                  />
                </div>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Container>
    </>
  );
}
