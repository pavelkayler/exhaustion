import { Accordion, Alert, Button, Card, Col, Form, Row } from "react-bootstrap";
import type { SignalPreset, SignalThresholds } from "../../shared/types/domain";

type NumericSectionKey = Exclude<keyof SignalThresholds, "observe"> | "observe";

type NumericFieldDescriptor = {
  key: string;
  label: string;
  step?: string;
  min?: number;
};

type Props = {
  presets: SignalPreset[];
  selectedPresetId: string | null;
  presetName: string;
  thresholds: SignalThresholds | null;
  loading: boolean;
  busyAction: "none" | "save" | "delete" | "apply";
  error: string | null;
  onPresetSelect: (presetId: string) => void;
  onPresetNameChange: (value: string) => void;
  onThresholdChange: (
    section: NumericSectionKey,
    field: string,
    value: number | boolean | null,
  ) => void;
  onSave: () => void;
  onDelete: () => void;
  onApply: () => void;
};

const CANDIDATE_FIELDS: NumericFieldDescriptor[] = [
  { key: "minPriceMove1mPct", label: "Min Price Move 1m %", step: "0.01", min: 0 },
  { key: "minPriceMove3mPct", label: "Min Price Move 3m %", step: "0.01", min: 0 },
  { key: "minPriceMove5mPct", label: "Min Price Move 5m %", step: "0.01", min: 0 },
  { key: "minPriceMove15mPct", label: "Min Price Move 15m %", step: "0.01", min: 0 },
  { key: "minVolumeBurstRatio", label: "Min Volume Burst", step: "0.01", min: 0 },
  { key: "minTurnoverBurstRatio", label: "Min Turnover Burst", step: "0.01", min: 0 },
  { key: "maxUniverseRank", label: "Max Universe Rank", step: "1", min: 1 },
  { key: "minTurnover24hUsd", label: "Min Turnover 24h", step: "1000", min: 0 },
  { key: "maxTurnover24hUsd", label: "Max Turnover 24h", step: "1000", min: 0 },
  { key: "minOpenInterestValueUsd", label: "Min OI Value", step: "1000", min: 0 },
  { key: "minTrades1m", label: "Min Trades 1m", step: "1", min: 0 },
  { key: "maxSpreadBps", label: "Max Spread Bps", step: "0.1", min: 0 },
  { key: "minDistanceFromLow24hPct", label: "Min Dist From Low 24h %", step: "0.01", min: 0 },
  { key: "minNearDepthUsd", label: "Min Near Depth", step: "1000", min: 0 },
  { key: "candidateScoreMin", label: "Candidate Score Min", step: "0.01", min: 0 },
];

const DERIVATIVE_FIELDS: NumericFieldDescriptor[] = [
  { key: "minOiMove1mPct", label: "Min OI Move 1m %", step: "0.001", min: 0 },
  { key: "minOiMove5mPct", label: "Min OI Move 5m %", step: "0.001", min: 0 },
  { key: "minOiAccelerationPct", label: "Min OI Acceleration %", step: "0.001", min: 0 },
  { key: "minFundingAbsPct", label: "Min Funding Abs %", step: "0.001", min: 0 },
  { key: "minLongShortRatio", label: "Min Long/Short Ratio", step: "0.01", min: 0 },
  { key: "longShortRatioWeight", label: "Long/Short Weight", step: "0.01", min: 0 },
  { key: "minShortLiquidationUsd60s", label: "Min Short Liq 60s", step: "1000", min: 0 },
  { key: "minShortLiquidationBurstRatio60s", label: "Min Short Liq Burst 60s", step: "0.01", min: 0 },
  { key: "minShortLiquidationImbalance60s", label: "Min Short Liq Imbalance 60s", step: "0.01", min: 0 },
  { key: "derivativesScoreMin", label: "Derivatives Score Min", step: "0.01", min: 0 },
];

const EXHAUSTION_FIELDS: NumericFieldDescriptor[] = [
  { key: "maxPriceContinuation30sPct", label: "Max Price Continuation 30s %", step: "0.01", min: 0 },
  { key: "maxPriceContinuation1mPct", label: "Max Price Continuation 1m %", step: "0.01", min: 0 },
  { key: "maxOiAccelerationPct", label: "Max OI Acceleration %", step: "0.01", min: 0 },
  { key: "minNegativeCvdDelta", label: "Min Negative CVD Delta", step: "0.01", min: 0 },
  { key: "minNegativeCvdImbalance", label: "Min Negative CVD Imbalance", step: "0.01", min: 0 },
  { key: "exhaustionScoreMin", label: "Exhaustion Score Min", step: "0.01", min: 0 },
];

const MICROSTRUCTURE_FIELDS: NumericFieldDescriptor[] = [
  { key: "minAskToBidDepthRatio", label: "Min Ask/Bid Depth Ratio", step: "0.01", min: 0 },
  { key: "minSellSideImbalance", label: "Min Sell-side Imbalance", step: "0.01", min: 0 },
  { key: "maxNearestAskWallBps", label: "Max Nearest Ask Wall Bps", step: "0.1", min: 0 },
  { key: "minNearestBidWallBps", label: "Min Nearest Bid Wall Bps", step: "0.1", min: 0 },
  { key: "maxSpreadBps", label: "Max Spread Bps", step: "0.1", min: 0 },
  { key: "minNearDepthUsd", label: "Min Near Depth", step: "1000", min: 0 },
  { key: "microstructureScoreMin", label: "Microstructure Score Min", step: "0.01", min: 0 },
];

const OBSERVE_FIELDS: NumericFieldDescriptor[] = [
  { key: "totalScoreMin", label: "Total Score Min", step: "0.01", min: 0 },
];

function renderNumber(
  section: NumericSectionKey,
  field: NumericFieldDescriptor,
  thresholds: SignalThresholds,
  onThresholdChange: Props["onThresholdChange"],
) {
  const sectionValues = thresholds[section] as Record<string, number | null>;
  const rawValue = sectionValues[field.key];
  return (
    <Col md={6} xl={4} key={`${section}:${field.key}`}>
      <Form.Group>
        <Form.Label>{field.label}</Form.Label>
        <Form.Control
          type="number"
          value={rawValue == null ? "" : String(rawValue)}
          min={field.min}
          step={field.step ?? "0.01"}
          onChange={(event) => {
            const nextValue = event.currentTarget.value.trim();
            onThresholdChange(
              section,
              field.key,
              nextValue === "" ? null : Number(nextValue),
            );
          }}
        />
      </Form.Group>
    </Col>
  );
}

export function SignalPresetEditorCard(props: Props) {
  const {
    presets,
    selectedPresetId,
    presetName,
    thresholds,
    loading,
    busyAction,
    error,
    onPresetSelect,
    onPresetNameChange,
    onThresholdChange,
    onSave,
    onDelete,
    onApply,
  } = props;

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;
  const canDelete = selectedPreset != null && selectedPreset.id !== "default" && busyAction === "none";

  return (
    <Card className="genesis-card">
      <Card.Header>Signal Presets</Card.Header>
      <Card.Body>
        {error ? (
          <Alert variant="danger" className="mb-3 py-2">
            {error}
          </Alert>
        ) : null}

        <Row className="g-3 align-items-end mb-3">
          <Col lg={4}>
            <Form.Group>
              <Form.Label>Preset</Form.Label>
              <Form.Select
                value={selectedPresetId ?? ""}
                disabled={loading || busyAction !== "none"}
                onChange={(event) => onPresetSelect(event.currentTarget.value)}
              >
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>

          <Col lg={4}>
            <Form.Group>
              <Form.Label>Preset Name</Form.Label>
              <Form.Control
                value={presetName}
                disabled={loading || busyAction !== "none"}
                onChange={(event) => onPresetNameChange(event.currentTarget.value)}
              />
            </Form.Group>
          </Col>

          <Col lg={4} className="d-flex gap-2 justify-content-lg-end">
            <Button variant="outline-light" disabled={loading || busyAction !== "none"} onClick={onSave}>
              {busyAction === "save" ? "Saving..." : "Save"}
            </Button>
            <Button variant="outline-danger" disabled={!canDelete} onClick={onDelete}>
              {busyAction === "delete" ? "Deleting..." : "Delete"}
            </Button>
            <Button variant="success" disabled={loading || busyAction !== "none" || thresholds == null} onClick={onApply}>
              {busyAction === "apply" ? "Applying..." : "Apply"}
            </Button>
          </Col>
        </Row>

        <div className="text-secondary small mb-3">
          Apply сохраняет пороги на бэке и, если сессия уже была запущена, сначала останавливает ее.
          После применения пресета запуск выполняется вручную кнопкой Start в шапке.
        </div>

        {thresholds == null ? (
          <div className="text-secondary">Loading presets...</div>
        ) : (
          <Accordion defaultActiveKey={["candidate"]} alwaysOpen>
            <Accordion.Item eventKey="candidate">
              <Accordion.Header>Candidate</Accordion.Header>
              <Accordion.Body>
                <Row className="g-3">
                  {CANDIDATE_FIELDS.map((field) => renderNumber("candidate", field, thresholds, onThresholdChange))}
                </Row>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="derivatives">
              <Accordion.Header>Derivatives</Accordion.Header>
              <Accordion.Body>
                <Row className="g-3 mb-3">
                  {DERIVATIVE_FIELDS.map((field) => renderNumber("derivatives", field, thresholds, onThresholdChange))}
                </Row>
                <Form.Check
                  type="switch"
                  id="signal-presets-use-long-short-ratio"
                  label="Use Long/Short Ratio"
                  checked={thresholds.derivatives.useLongShortRatio}
                  onChange={(event) => onThresholdChange("derivatives", "useLongShortRatio", event.currentTarget.checked)}
                />
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="exhaustion">
              <Accordion.Header>Exhaustion</Accordion.Header>
              <Accordion.Body>
                <Row className="g-3">
                  {EXHAUSTION_FIELDS.map((field) => renderNumber("exhaustion", field, thresholds, onThresholdChange))}
                </Row>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="microstructure">
              <Accordion.Header>Microstructure</Accordion.Header>
              <Accordion.Body>
                <Row className="g-3">
                  {MICROSTRUCTURE_FIELDS.map((field) => renderNumber("microstructure", field, thresholds, onThresholdChange))}
                </Row>
              </Accordion.Body>
            </Accordion.Item>

            <Accordion.Item eventKey="observe">
              <Accordion.Header>Final Score</Accordion.Header>
              <Accordion.Body>
                <Row className="g-3">
                  {OBSERVE_FIELDS.map((field) => renderNumber("observe", field, thresholds, onThresholdChange))}
                </Row>
              </Accordion.Body>
            </Accordion.Item>
          </Accordion>
        )}
      </Card.Body>
    </Card>
  );
}
