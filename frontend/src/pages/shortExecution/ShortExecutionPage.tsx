
import { Col, Container, Row } from "react-bootstrap";
import { HeaderBar } from "../dashboard/components/HeaderBar";
import { useSessionRuntime } from "../../features/session/hooks/useSessionRuntime";
import { useWsFeed } from "../../features/ws/hooks/useWsFeed";
import { usePrivatePositionsFeed } from "../../features/positions/hooks/usePrivatePositionsFeed";
import { useExecutorRuntime } from "../../features/executor/hooks/useExecutorRuntime";
import {
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

  const executor = useExecutorRuntime({ pollMs: 4_000 });

  const effectiveMode =
    executor.desiredRunning && executor.activeSettings
      ? executor.activeSettings.mode
      : executor.settings.mode;

  const executionFeed = usePrivatePositionsFeed(effectiveMode);

  const updateNumber = (key: NumericFieldKey, value: string) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    void executor.updateSettings({ [key]: numeric });
  };

  const updateBoolean = (
    key: keyof typeof executor.settings,
    value: boolean,
  ) => {
    void executor.updateSettings({ [key]: value });
  };

  const updateMode = (mode: "demo" | "real") => {
    void executor.updateSettings({ mode });
  };

  const updateExit = (exit: typeof executor.settings.exit) => {
    void executor.updateSettings({ exit });
  };

  const sessionActive =
    status.sessionState === "RUNNING" ||
    status.sessionState === "PAUSED" ||
    status.sessionState === "PAUSING" ||
    status.sessionState === "RESUMING";

  const canStartTracking =
    sessionActive &&
    executor.busy === "none" &&
    !executor.desiredRunning;

  const canStopTracking =
    executor.busy === "none" &&
    executor.desiredRunning;

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
        canRefresh={!executionFeed.refreshing}
        refreshBusy={executionFeed.refreshing}
        onRefresh={() => void executionFeed.refresh()}
      />

      <Container fluid className="py-3 px-2">
        <ExecutionHeaderCard mode={effectiveMode} feedStatus={executionFeed.status} />

        <Row className="g-3">
          <Col xs={12}>
            <ExecutionPositionsCard
              positions={executionFeed.positions}
              status={executionFeed.status}
              error={executionFeed.error}
              updatedAt={executionFeed.updatedAt}
              marketRows={rows}
              marketUpdatedAt={lastServerTime}
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
              settings={executor.settings}
              executorStatus={executor.status}
              executorError={executor.error}
              executorBusy={executor.busy}
              canStartTracking={canStartTracking}
              canStopTracking={canStopTracking}
              onStartTracking={() => void executor.start()}
              onStopTracking={() => void executor.stop()}
              onModeChange={updateMode}
              onExitChange={updateExit}
              onUpdateNumber={updateNumber}
              onUpdateBoolean={updateBoolean}
            />
          </Col>
        </Row>
      </Container>
    </>
  );
}
