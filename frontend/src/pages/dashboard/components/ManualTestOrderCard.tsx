import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row } from "react-bootstrap";
import { submitManualTestOrder } from "../../../features/manualOrders/api/manualOrdersApi";
import type { AvailableWsSymbol, ManualTestOrderResponse, SessionState, SymbolRow } from "../../../shared/types/domain";

type Props = {
  sessionState: SessionState;
  availableSymbols: string[];
  availableRows: SymbolRow[];
  availableWsRows: AvailableWsSymbol[];
  paperDefaults?: {
    marginUSDT?: number;
    entryOffsetPct?: number;
    leverage?: number;
    tpRoiPct?: number;
    slRoiPct?: number;
  };
  onRequestRowsRefresh: (mode?: "tick" | "snapshot") => void;
  onRequestEventsTail: (limit: number) => void;
};

function formatNumericInput(value: number | null): string {
  if (!Number.isFinite(value as number) || Number(value) <= 0) return "";
  return Number(Number(value).toFixed(8)).toString();
}

function calcDefaultTpSl(entry: number, side: "LONG" | "SHORT", leverage: number, tpRoiPct: number, slRoiPct: number) {
  const safeLeverage = Math.max(1, leverage);
  const tpMove = (tpRoiPct / 100) / safeLeverage;
  const slMove = (slRoiPct / 100) / safeLeverage;
  if (side === "LONG") {
    return {
      tp: entry * (1 + tpMove),
      sl: entry * (1 - slMove),
    };
  }
  return {
    tp: entry * (1 - tpMove),
    sl: entry * (1 + slMove),
  };
}

export function ManualTestOrderCard(props: Props) {
  const { sessionState, availableSymbols, availableRows, availableWsRows, paperDefaults, onRequestRowsRefresh, onRequestEventsTail } = props;
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [executionMode, setExecutionMode] = useState<"demo" | "real">("demo");
  const [marginUsdtInput, setMarginUsdtInput] = useState("");
  const [leverageInput, setLeverageInput] = useState("");
  const [entryOffsetPct, setEntryOffsetPct] = useState("");
  const [tpRoiInput, setTpRoiInput] = useState("");
  const [slRoiInput, setSlRoiInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManualTestOrderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimersRef = useRef<number[]>([]);
  const lastAutoFillKeyRef = useRef("");

  const normalizedSymbols = useMemo(
    () => Array.from(new Set((availableSymbols ?? []).map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [availableSymbols],
  );
  const selectedRow = useMemo(
    () => (availableRows ?? []).find((row) => String(row.symbol ?? "").trim().toUpperCase() === symbol) ?? null,
    [availableRows, symbol],
  );
  const selectedWsRow = useMemo(
    () => (availableWsRows ?? []).find((row) => String(row.symbol ?? "").trim().toUpperCase() === symbol) ?? null,
    [availableWsRows, symbol],
  );
  const referencePrice = useMemo(() => {
    if (selectedRow?.prevCandleClose != null && Number(selectedRow.prevCandleClose) > 0) return Number(selectedRow.prevCandleClose);
    if (selectedRow?.lastPrice != null && Number(selectedRow.lastPrice) > 0) return Number(selectedRow.lastPrice);
    if (selectedRow?.markPrice != null && Number(selectedRow.markPrice) > 0) return Number(selectedRow.markPrice);
    if (selectedWsRow?.lastPrice != null && Number(selectedWsRow.lastPrice) > 0) return Number(selectedWsRow.lastPrice);
    if (selectedWsRow?.markPrice != null && Number(selectedWsRow.markPrice) > 0) return Number(selectedWsRow.markPrice);
    return null;
  }, [selectedRow, selectedWsRow]);

  useEffect(() => {
    if (!symbol && normalizedSymbols.length > 0) {
      setSymbol(normalizedSymbols[0] ?? "");
      return;
    }
    if (symbol && !normalizedSymbols.includes(symbol)) {
      setSymbol(normalizedSymbols[0] ?? "");
    }
  }, [normalizedSymbols, symbol]);

  useEffect(() => () => {
    for (const timer of refreshTimersRef.current) {
      window.clearTimeout(timer);
    }
    refreshTimersRef.current = [];
  }, []);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, []);

  const requiresExplicitPrices = true;
  const defaultMarginUsdt = Math.max(0, Number(paperDefaults?.marginUSDT) || 0);
  const defaultEntryOffsetPct = Math.max(0, Number(paperDefaults?.entryOffsetPct) || 0);
  const defaultLeverage = Math.max(1, Number(paperDefaults?.leverage) || 1);
  const leverage = Math.max(1, Number(leverageInput) || defaultLeverage);
  const marginUsdt = Math.max(0, Number(marginUsdtInput) || defaultMarginUsdt);
  const tpRoiPct = Math.max(0, Number(paperDefaults?.tpRoiPct) || 0);
  const slRoiPct = Math.max(0, Number(paperDefaults?.slRoiPct) || 0);
  const computedEntryPrice = useMemo(() => {
    const ref = referencePrice;
    const offset = Number(entryOffsetPct);
    if (!Number.isFinite(ref as number) || Number(ref) <= 0) return null;
    if (!Number.isFinite(offset) || offset < 0) return null;
    return side === "LONG"
      ? Number(ref) * (1 - (offset / 100))
      : Number(ref) * (1 + (offset / 100));
  }, [referencePrice, entryOffsetPct, side]);

  useEffect(() => {
    if (!requiresExplicitPrices) return;
    const autoFillKey = `${symbol}:${side}`;
    if (!symbol || autoFillKey === lastAutoFillKeyRef.current) return;
    if (!(referencePrice && referencePrice > 0)) return;

    setEntryOffsetPct(formatNumericInput(defaultEntryOffsetPct));
    setTpRoiInput(formatNumericInput(tpRoiPct));
    setSlRoiInput(formatNumericInput(slRoiPct));
    lastAutoFillKeyRef.current = autoFillKey;
  }, [symbol, side, referencePrice, defaultEntryOffsetPct, tpRoiPct, slRoiPct]);

  useEffect(() => {
    if (!marginUsdtInput && defaultMarginUsdt > 0) {
      setMarginUsdtInput(formatNumericInput(defaultMarginUsdt));
    }
  }, [marginUsdtInput, defaultMarginUsdt]);

  useEffect(() => {
    if (!leverageInput && defaultLeverage > 0) {
      setLeverageInput(formatNumericInput(defaultLeverage));
    }
  }, [leverageInput, defaultLeverage]);

  const computedTpPrice = useMemo(() => {
    const entry = Number(computedEntryPrice);
    const roi = Number(tpRoiInput);
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(roi) || roi <= 0) return null;
    return calcDefaultTpSl(entry, side, leverage, roi, 1).tp;
  }, [computedEntryPrice, tpRoiInput, side, leverage]);

  const computedSlPrice = useMemo(() => {
    const entry = Number(computedEntryPrice);
    const roi = Number(slRoiInput);
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(roi) || roi <= 0) return null;
    return calcDefaultTpSl(entry, side, leverage, 1, roi).sl;
  }, [computedEntryPrice, slRoiInput, side, leverage]);

  const explicitPricesValid =
    !requiresExplicitPrices
    || (
      Number.isFinite(Number(marginUsdtInput))
      && Number(marginUsdtInput) > 0
      && Number.isFinite(Number(leverageInput))
      && Number(leverageInput) >= 1
      && Number.isFinite(Number(entryOffsetPct))
      && Number(entryOffsetPct) >= 0
      && Number.isFinite(Number(computedEntryPrice))
      && Number(computedEntryPrice) > 0
      && Number.isFinite(Number(tpRoiInput))
      && Number(tpRoiInput) > 0
      && Number.isFinite(Number(slRoiInput))
      && Number(slRoiInput) > 0
      && Number.isFinite(Number(computedTpPrice))
      && Number(computedTpPrice) > 0
      && Number.isFinite(Number(computedSlPrice))
      && Number(computedSlPrice) > 0
    );

  const canSubmit = symbol.trim().length > 0 && explicitPricesValid && !busy;

  async function onSubmit() {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) return;
    setBusy(true);
    setError(null);
    try {
      const response = await submitManualTestOrder({
        symbol: normalizedSymbol,
        side,
        executionMode,
        ...(requiresExplicitPrices
          ? {
              entryPrice: Number(computedEntryPrice),
              tpPrice: Number(computedTpPrice),
              slPrice: Number(computedSlPrice),
              marginUSDT: Number(marginUsdt),
              leverage: Number(leverage),
            }
          : {}),
      });
      setResult(response);
      onRequestRowsRefresh("snapshot");
      onRequestEventsTail(25);
      for (const timer of refreshTimersRef.current) {
        window.clearTimeout(timer);
      }
      refreshTimersRef.current = [
        window.setTimeout(() => onRequestRowsRefresh("snapshot"), 1500),
        window.setTimeout(() => onRequestRowsRefresh("snapshot"), 4500),
        window.setTimeout(() => onRequestEventsTail(25), 1500),
      ];
    } catch (e) {
      setResult(null);
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const statusVariant = error
    ? { bg: "danger", text: error }
    : result
      ? result.accepted
        ? { bg: "success", text: result.message }
        : { bg: "warning", text: result.message }
      : null;

  return (
    <Card className="mt-3">
      <Card.Header className="d-flex align-items-center gap-2 flex-wrap">
        <b>Manual test order</b>
        <Badge bg={executionMode === "demo" ? "warning" : "danger"}>
          mode: {executionMode}
        </Badge>
        <Badge bg={sessionState === "RUNNING" ? "success" : "secondary"}>
          session: {sessionState}
        </Badge>
        <div className="ms-auto" style={{ fontSize: 12, opacity: 0.8 }}>
          Uses the selected test broker and current bot order settings.
        </div>
      </Card.Header>
      <Card.Body>
        <Row className="g-3">
          <Col xl={2} md={6}>
            <Form.Group>
              <Form.Label>Broker mode</Form.Label>
              <Form.Select value={executionMode} onChange={(e) => setExecutionMode(e.currentTarget.value === "real" ? "real" : "demo")}>
                <option value="demo">Demo</option>
                <option value="real">Real</option>
              </Form.Select>
              <Form.Text muted>
                Independent from the execution profile above. This selector chooses where the manual test order is sent.
              </Form.Text>
            </Form.Group>
          </Col>
          <Col xl={3} md={6}>
            <Form.Group>
              <Form.Label>Symbol</Form.Label>
              <Form.Select
                value={symbol}
                onChange={(e) => setSymbol(e.currentTarget.value)}
                disabled={normalizedSymbols.length === 0}
              >
                {normalizedSymbols.length === 0 ? (
                  <option value="">No WS symbols available yet</option>
                ) : null}
                {normalizedSymbols.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Form.Select>
              <Form.Text muted>
                Symbol from the common WS market pool. The dropdown shows only tickers that currently have an active market snapshot.
              </Form.Text>
            </Form.Group>
          </Col>
          <Col xl={2} md={6}>
            <Form.Group>
              <Form.Label>Side</Form.Label>
              <Form.Select value={side} onChange={(e) => setSide(e.currentTarget.value === "SHORT" ? "SHORT" : "LONG")}>
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
              </Form.Select>
              <Form.Text muted>
                Direction of the limit order. Default: LONG.
              </Form.Text>
            </Form.Group>
          </Col>
          <Col xl={2} md={6}>
            <Form.Group>
              <Form.Label>Margin, USDT</Form.Label>
              <Form.Control
                type="number"
                min={0}
                step="any"
                value={marginUsdtInput}
                onChange={(e) => setMarginUsdtInput(e.currentTarget.value)}
                placeholder="Default: current bot margin"
              />
              <Form.Text muted>
                Margin allocated to this manual order. Default: current bot margin.
              </Form.Text>
            </Form.Group>
          </Col>
          <Col xl={2} md={6}>
            <Form.Group>
              <Form.Label>Leverage</Form.Label>
              <Form.Control
                type="number"
                min={1}
                step="any"
                value={leverageInput}
                onChange={(e) => setLeverageInput(e.currentTarget.value)}
                placeholder="Default: current bot leverage"
              />
              <Form.Text muted>
                Leverage used to calculate quantity and TP/SL prices. Bybit ROI in the order modal is based on the actual position leverage for this symbol.
              </Form.Text>
            </Form.Group>
          </Col>
        </Row>
        <Row className="g-3" style={{ marginTop: 4 }}>
          {requiresExplicitPrices ? (
            <>
              <Col xl={3} md={4}>
                <Form.Group>
                  <Form.Label>Entry offset, %</Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    step="any"
                    value={entryOffsetPct}
                    onChange={(e) => setEntryOffsetPct(e.currentTarget.value)}
                    placeholder="Default: bot entry offset"
                  />
                  <Form.Text muted>
                    Offset from the reference price. Default: current bot entry offset. Reference: {referencePrice != null ? formatNumericInput(referencePrice) : "-"}, limit: {computedEntryPrice != null ? formatNumericInput(computedEntryPrice) : "-"}.
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col xl={3} md={4}>
                <Form.Group>
                  <Form.Label>TP ROI, %</Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    step="any"
                    value={tpRoiInput}
                    onChange={(e) => setTpRoiInput(e.currentTarget.value)}
                    placeholder="Default: from TP ROI"
                  />
                  <Form.Text muted>
                    ROI percent from entry. Default: current TP ROI. Calculated TP price: {computedTpPrice != null ? formatNumericInput(computedTpPrice) : "-"}.
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col xl={3} md={4}>
                <Form.Group>
                  <Form.Label>SL ROI, %</Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    step="any"
                    value={slRoiInput}
                    onChange={(e) => setSlRoiInput(e.currentTarget.value)}
                    placeholder="Default: from SL ROI"
                  />
                  <Form.Text muted>
                    ROI percent from entry. Default: current SL ROI. Calculated SL price: {computedSlPrice != null ? formatNumericInput(computedSlPrice) : "-"}.
                  </Form.Text>
                </Form.Group>
              </Col>
            </>
          ) : null}
        </Row>
        <Row className="g-3 align-items-end" style={{ marginTop: 4 }}>
          <Col xl={5} md={12}>
            <div className="d-flex gap-2 align-items-center flex-wrap">
              <Button variant="outline-primary" disabled={!canSubmit} onClick={() => void onSubmit()}>
                {busy ? "Sending..." : "Send test order"}
              </Button>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              {executionMode === "demo"
                ? "Demo order can be sent without starting the bot session. Symbol, direction, margin, leverage, entry offset, TP and SL are mandatory."
                : "Real order can be sent without starting the bot session. Symbol, direction, margin, leverage, entry offset, TP and SL are mandatory."}
            </div>
          </Col>
        </Row>

        {statusVariant ? (
          <div style={{ marginTop: 12 }}>
            <Badge bg={statusVariant.bg as "success" | "warning" | "danger" | "secondary"}>{statusVariant.text}</Badge>
            {!result?.accepted && (result?.retCode != null || result?.retMsg) ? (
              <div style={{ fontSize: 12, lineHeight: "18px", marginTop: 6 }}>
                broker error: {result?.retCode != null ? `[${result.retCode}] ` : ""}{result?.retMsg ?? "-"}
              </div>
            ) : null}
          </div>
        ) : null}

        {result?.row ? (
          <div style={{ marginTop: 12, fontSize: 12, lineHeight: "18px" }}>
            <div><b>{result.row.symbol}</b> | state: {result.row.paperStatus ?? "IDLE"} | side: {result.row.paperSide ?? "-"}</div>
            <div>entry: {result.row.paperEntryPrice ?? "-"} | tp: {result.row.paperTpPrice ?? "-"} | sl: {result.row.paperSlPrice ?? "-"} | qty: {result.row.paperQty ?? "-"}</div>
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}
