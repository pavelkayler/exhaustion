import { Button, Card, Col, Form, Row, Spinner } from "react-bootstrap";
import type { ExecutorStatus } from "../../../shared/types/domain";
import type {
  ExecutorLocalSettings,
  NumericFieldKey,
} from "../model";

type Props = {
  settings: ExecutorLocalSettings;
  executorStatus: ExecutorStatus;
  executorError: string | null;
  executorBusy: "none" | "start" | "stop" | "save";
  canStartTracking: boolean;
  canStopTracking: boolean;
  onStartTracking: () => void;
  onStopTracking: () => void;
  onModeChange: (mode: "demo" | "real") => void;
  onExitChange: (value: ExecutorLocalSettings["exit"]) => void;
  onUpdateNumber: (key: NumericFieldKey, value: string) => void;
  onUpdateBoolean: (key: keyof ExecutorLocalSettings, value: boolean) => void;
};

function renderExecutorStatus(status: ExecutorStatus): string {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting_session":
      return "waiting for session";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

export function ExecutionSettingsCard({
  settings,
  executorStatus,
  executorError,
  executorBusy,
  canStartTracking,
  canStopTracking,
  onStartTracking,
  onStopTracking,
  onModeChange,
  onExitChange,
  onUpdateNumber,
  onUpdateBoolean,
}: Props) {
  return (
    <Card className="genesis-card">
      <Card.Header className="d-flex justify-content-between align-items-center gap-3 flex-wrap">
        <div className="d-flex flex-column">
          <span>Execution Settings</span>
          <small className="text-secondary">
            Stored on server. Changes apply to executor after stop-start.
          </small>
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <small className="text-secondary">
            executor: {renderExecutorStatus(executorStatus)}
          </small>
          <Button
            size="sm"
            variant="success"
            onClick={onStartTracking}
            disabled={!canStartTracking}
          >
            {executorBusy === "start" ? <Spinner animation="border" size="sm" /> : "Start"}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={onStopTracking}
            disabled={!canStopTracking}
          >
            {executorBusy === "stop" ? <Spinner animation="border" size="sm" /> : "Stop"}
          </Button>
        </div>
      </Card.Header>
      <Card.Body>
        <Row className="g-3">
          <Col md={4}>
            <Form.Group>
              <Form.Label>Mode</Form.Label>
              <Form.Select
                value={settings.mode}
                onChange={(event) =>
                  onModeChange(event.target.value === "real" ? "real" : "demo")
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
                step="any"
                value={settings.maxUsdt}
                onChange={(event) => onUpdateNumber("maxUsdt", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Leverage</Form.Label>
              <Form.Control
                type="number"
                step="any"
                value={settings.leverage}
                onChange={(event) => onUpdateNumber("leverage", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>TP %</Form.Label>
              <Form.Control
                type="number"
                step="any"
                value={settings.tpPct}
                onChange={(event) => onUpdateNumber("tpPct", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>SL %</Form.Label>
              <Form.Control
                type="number"
                step="any"
                value={settings.slPct}
                onChange={(event) => onUpdateNumber("slPct", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Exit</Form.Label>
              <Form.Select
                value={settings.exit}
                onChange={(event) =>
                  onExitChange(
                    event.target.value === "partial_and_trailing"
                      ? "partial_and_trailing"
                      : event.target.value === "trailing"
                        ? "trailing"
                        : "full",
                  )
                }
              >
                <option value="full">full</option>
                <option value="partial_and_trailing">partial and trailing</option>
                <option value="trailing">trailing</option>
              </Form.Select>
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>First order offset %</Form.Label>
              <Form.Control
                type="number"
                step="any"
                value={settings.firstOrderOffsetPct}
                onChange={(event) =>
                  onUpdateNumber("firstOrderOffsetPct", event.target.value)
                }
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Grid orders count</Form.Label>
              <Form.Control
                type="number"
                step="1"
                value={settings.gridOrdersCount}
                onChange={(event) => onUpdateNumber("gridOrdersCount", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Grid step %</Form.Label>
              <Form.Control
                type="number"
                step="any"
                value={settings.gridStepPct}
                onChange={(event) => onUpdateNumber("gridStepPct", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Order Alive min</Form.Label>
              <Form.Control
                type="number"
                step="1"
                value={settings.orderAliveMin}
                onChange={(event) => onUpdateNumber("orderAliveMin", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Cooldown min</Form.Label>
              <Form.Control
                type="number"
                step="1"
                value={settings.cooldownMin}
                onChange={(event) => onUpdateNumber("cooldownMin", event.target.value)}
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
              onUpdateBoolean("trackCandidateSignalsForResearch", event.target.checked)
            }
          />
          <Form.Check
            type="checkbox"
            label="Take candidate signals in live execution"
            checked={settings.takeCandidateSignalsInLiveExecution}
            onChange={(event) =>
              onUpdateBoolean("takeCandidateSignalsInLiveExecution", event.target.checked)
            }
          />
          <Form.Check
            type="checkbox"
            label="Take final signals"
            checked={settings.takeFinalSignals}
            onChange={(event) => onUpdateBoolean("takeFinalSignals", event.target.checked)}
          />
          <Form.Check
            type="checkbox"
            label="Cancel stale entry orders"
            checked={settings.cancelActivePositionOrders}
            onChange={(event) =>
              onUpdateBoolean("cancelActivePositionOrders", event.target.checked)
            }
          />
        </div>

        {executorError ? (
          <div className="text-danger mt-3">{executorError}</div>
        ) : null}
      </Card.Body>
    </Card>
  );
}
