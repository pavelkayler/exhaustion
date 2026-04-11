import { Col, Container, Row } from "react-bootstrap";
import { HeaderBar } from "../dashboard/components/HeaderBar";
import { useSessionRuntime } from "../../features/session/hooks/useSessionRuntime";
import { useWsFeed } from "../../features/ws/hooks/useWsFeed";
import { usePersistentState } from "../../shared/hooks/usePersistentState";
import { usePrivatePositionsFeed } from "../../features/positions/hooks/usePrivatePositionsFeed";
import {
  DEFAULT_EXECUTOR_LOCAL_SETTINGS,
  type ExecutorLocalSettings,
  type NumericFieldKey,
} from "./model";
import { ExecutionHeaderCard } from "./components/ExecutionHeaderCard";
import { ExecutionPositionsCard } from "./components/ExecutionPositionsCard";
import { ExecutionOrdersCard } from "./components/ExecutionOrdersCard";
import { ExecutionSettingsCard } from "./components/ExecutionSettingsCard";

export function ShortExecutionPage() {
  const { conn, lastServerTime, wsUrl, streams, rows } = useWsFeed();
  const {
    status,
    busy,
    start,
    stop,
    pause,
    resume,
    canStart,
    canStop,
    canPause,
    canResume,
  } = useSessionRuntime();

  const [settings, setSettings] = usePersistentState<ExecutorLocalSettings>(
    "short-execution.local-settings",
    DEFAULT_EXECUTOR_LOCAL_SETTINGS,
  );

  const executionFeed = usePrivatePositionsFeed(settings.mode);

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

  const updateMode = (mode: "demo" | "real") => {
    setSettings((prev) => ({
      ...prev,
      mode,
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
        <ExecutionHeaderCard mode={settings.mode} feedStatus={executionFeed.status} />

        <Row className="g-3">
          <Col xs={12}>
            <ExecutionPositionsCard
              rows={rows}
              positions={executionFeed.positions}
              status={executionFeed.status}
              error={executionFeed.error}
              updatedAt={executionFeed.updatedAt}
            />
          </Col>

          <Col xs={12}>
            <ExecutionOrdersCard
              orders={executionFeed.orders}
              status={executionFeed.status}
              error={executionFeed.error}
            />
          </Col>

          <Col xs={12}>
            <ExecutionSettingsCard
              settings={settings}
              onModeChange={updateMode}
              onUpdateNumber={updateNumber}
              onUpdateBoolean={updateBoolean}
            />
          </Col>
        </Row>
      </Container>
    </>
  );
}
