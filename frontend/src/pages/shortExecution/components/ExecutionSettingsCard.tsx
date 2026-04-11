import { Card, Col, Form, Row } from "react-bootstrap";
import type {
  ExecutorLocalSettings,
  NumericFieldKey,
} from "../model";

type Props = {
  settings: ExecutorLocalSettings;
  onModeChange: (mode: "demo" | "real") => void;
  onUpdateNumber: (key: NumericFieldKey, value: string) => void;
  onUpdateBoolean: (key: keyof ExecutorLocalSettings, value: boolean) => void;
};

export function ExecutionSettingsCard({
  settings,
  onModeChange,
  onUpdateNumber,
  onUpdateBoolean,
}: Props) {
  return (
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
                value={settings.slPct}
                onChange={(event) => onUpdateNumber("slPct", event.target.value)}
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
                value={settings.gridStepPct}
                onChange={(event) => onUpdateNumber("gridStepPct", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Stale sec</Form.Label>
              <Form.Control
                type="number"
                value={settings.staleSec}
                onChange={(event) => onUpdateNumber("staleSec", event.target.value)}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group>
              <Form.Label>Cooldown min</Form.Label>
              <Form.Control
                type="number"
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
            label="Cancel active position orders"
            checked={settings.cancelActivePositionOrders}
            onChange={(event) =>
              onUpdateBoolean("cancelActivePositionOrders", event.target.checked)
            }
          />
        </div>
      </Card.Body>
    </Card>
  );
}
