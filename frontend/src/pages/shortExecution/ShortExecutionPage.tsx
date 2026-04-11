import { Card, Col, Container, Form, Row } from "react-bootstrap";
import { HeaderBar } from "../dashboard/components/HeaderBar";
import { useSessionRuntime } from "../../features/session/hooks/useSessionRuntime";
import { useWsFeed } from "../../features/ws/hooks/useWsFeed";
import { usePersistentState } from "../../shared/hooks/usePersistentState";

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

export function ShortExecutionPage() {
  const {
    conn,
    lastServerTime,
    wsUrl,
    streams,
  } = useWsFeed();
  const { status, busy, start, stop, pause, resume, canStart, canStop, canPause, canResume } = useSessionRuntime();
  const [settings, setSettings] = usePersistentState<ExecutorLocalSettings>("short-execution.local-settings", DEFAULT_SETTINGS);

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
                  <Form.Select value={settings.mode} onChange={(event) => setSettings((prev) => ({ ...prev, mode: event.target.value === "real" ? "real" : "demo" }))}>
                    <option value="demo">demo</option>
                    <option value="real">real</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Max USDT</Form.Label>
                  <Form.Control type="number" value={settings.maxUsdt} onChange={(event) => updateNumber("maxUsdt", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Leverage</Form.Label>
                  <Form.Control type="number" value={settings.leverage} onChange={(event) => updateNumber("leverage", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>TP %</Form.Label>
                  <Form.Control type="number" value={settings.tpPct} onChange={(event) => updateNumber("tpPct", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>SL %</Form.Label>
                  <Form.Control type="number" value={settings.slPct} onChange={(event) => updateNumber("slPct", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>First order offset %</Form.Label>
                  <Form.Control type="number" value={settings.firstOrderOffsetPct} onChange={(event) => updateNumber("firstOrderOffsetPct", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Grid orders count</Form.Label>
                  <Form.Control type="number" value={settings.gridOrdersCount} onChange={(event) => updateNumber("gridOrdersCount", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Grid step %</Form.Label>
                  <Form.Control type="number" value={settings.gridStepPct} onChange={(event) => updateNumber("gridStepPct", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Stale sec</Form.Label>
                  <Form.Control type="number" value={settings.staleSec} onChange={(event) => updateNumber("staleSec", event.target.value)} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label>Cooldown min</Form.Label>
                  <Form.Control type="number" value={settings.cooldownMin} onChange={(event) => updateNumber("cooldownMin", event.target.value)} />
                </Form.Group>
              </Col>
            </Row>
            <div className="d-flex flex-column gap-2 mt-4">
              <Form.Check
                type="checkbox"
                label="Track candidate signals for research"
                checked={settings.trackCandidateSignalsForResearch}
                onChange={(event) => updateBoolean("trackCandidateSignalsForResearch", event.target.checked)}
              />
              <Form.Check
                type="checkbox"
                label="Take candidate signals in live execution"
                checked={settings.takeCandidateSignalsInLiveExecution}
                onChange={(event) => updateBoolean("takeCandidateSignalsInLiveExecution", event.target.checked)}
              />
              <Form.Check
                type="checkbox"
                label="Take final signals"
                checked={settings.takeFinalSignals}
                onChange={(event) => updateBoolean("takeFinalSignals", event.target.checked)}
              />
              <Form.Check
                type="checkbox"
                label="Cancel active position orders"
                checked={settings.cancelActivePositionOrders}
                onChange={(event) => updateBoolean("cancelActivePositionOrders", event.target.checked)}
              />
            </div>
          </Card.Body>
        </Card>
      </Container>
    </>
  );
}
