
import { useContext } from "react";
import { Badge, Button, Container, Nav, Navbar, Spinner } from "react-bootstrap";
import { Link } from "react-router-dom";
import { preloadRoute } from "../../../app/routing/routes";
import { AppContext } from "../../../app/providers/context/AppContext";
import { useExecutorStatusLite } from "../../../features/executor/hooks/useExecutorRuntime";
import { useStableStreamsStatus } from "../../../features/ws/hooks/useStableStreamsStatus";
import type { ConnStatus, SessionState, StreamsState } from "../../../shared/types/domain";

type Props = {
  conn: ConnStatus;
  sessionState: SessionState;
  runningBotName?: string | null;
  wsUrl: string;
  lastServerTime: number | null;
  streams: StreamsState;
  canStart: boolean;
  canStop: boolean;
  canPause: boolean;
  canResume: boolean;
  busy: "none" | "start" | "stop" | "pause" | "resume";
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  overlayError?: string | null;
  canRefresh?: boolean;
  refreshBusy?: boolean;
  onRefresh?: () => void;
};

export function HeaderBar(props: Props) {
  const { appName, appUpdatedDate, appVersion } = useContext(AppContext);
  const executor = useExecutorStatusLite({ pollMs: 5_000 });
  const {
    conn,
    sessionState,
    runningBotName,
    lastServerTime,
    streams,
    canStart,
    canStop,
    busy,
    onStart,
    onStop,
    overlayError,
    canRefresh = false,
    refreshBusy = false,
    onRefresh,
  } = props;
  const stableStreams = useStableStreamsStatus(streams);

  const connVariant = conn === "CONNECTED" ? "success" : conn === "CONNECTING" || conn === "RECONNECTING" ? "warning" : "danger";
  const sessionVariant = sessionState === "RUNNING" ? "success" : sessionState === "STOPPING" || sessionState === "PAUSING" || sessionState === "RESUMING" ? "warning" : "secondary";
  const streamsVariant = !stableStreams.streamsEnabled ? "secondary" : stableStreams.bybitConnected ? "success" : "warning";
  const streamsText = !stableStreams.streamsEnabled ? "Streams: OFF" : stableStreams.bybitConnected ? "Streams: ON" : "Streams: ON (reconnecting)";
  const showRunningBot = sessionState !== "STOPPED" && Boolean(String(runningBotName ?? "").trim());
  const showExecutorRunning = executor.status === "running";
  const preloadNavRoute = (path: string) => {
    void preloadRoute(path);
  };

  return (
    <Navbar className="genesis-topbar">
      {overlayError ? (
        <div className="genesis-topbar-overlay-error" title={overlayError}>
          {overlayError}
        </div>
      ) : null}
      <Container fluid className="genesis-topbar-layout">
        <div className="genesis-topbar-main">
          <Navbar.Brand>{appName}</Navbar.Brand>
          <Nav className="genesis-topbar-nav">
            <Nav.Link as={Link} to="/" onMouseEnter={() => preloadNavRoute("/")} onFocus={() => preloadNavRoute("/")}>Dashboard</Nav.Link>
            <Nav.Link as={Link} to="/signals" onMouseEnter={() => preloadNavRoute("/signals")} onFocus={() => preloadNavRoute("/signals")}>Signals</Nav.Link>
            <Nav.Link as={Link} to="/execution" onMouseEnter={() => preloadNavRoute("/execution")} onFocus={() => preloadNavRoute("/execution")}>Execution</Nav.Link>
          </Nav>
        </div>
        <div className="genesis-topbar-status-row">
          <div className="genesis-topbar-statuses">
            <Badge bg={connVariant} className="genesis-topbar-fixed-badge">{conn}</Badge>
            <Badge bg={streamsVariant} className="genesis-topbar-fixed-badge">{streamsText}</Badge>
            <Badge bg={sessionVariant} className="genesis-topbar-fixed-badge">Session: {sessionState}</Badge>
            {showExecutorRunning ? (
              <Badge bg="warning" text="dark" className="genesis-topbar-fixed-badge">
                Executor: RUNNING
              </Badge>
            ) : null}
            {showRunningBot ? <Badge bg="info" text="dark">Bot: {runningBotName}</Badge> : null}
          </div>
          <div className="genesis-topbar-actions">
            {onRefresh ? (
              <Button size="sm" variant="outline-light" onClick={onRefresh} disabled={!canRefresh}>
                {refreshBusy ? <Spinner animation="border" size="sm" /> : "Refresh"}
              </Button>
            ) : null}
            <Button size="sm" variant="success" onClick={onStart} disabled={!canStart}>{busy === "start" ? <Spinner animation="border" size="sm" /> : "Start"}</Button>
            <Button size="sm" variant="danger" onClick={onStop} disabled={!canStop}>{busy === "stop" ? <Spinner animation="border" size="sm" /> : "Stop"}</Button>
          </div>
        </div>
        <div className="genesis-topbar-meta-overlay" title={`Last tick: ${lastServerTime ? new Date(lastServerTime).toLocaleTimeString() : "-"} | ver. ${appVersion}, updated ${appUpdatedDate}`}>
          Last tick: {lastServerTime ? new Date(lastServerTime).toLocaleTimeString() : "-"} | ver. {appVersion}, updated {appUpdatedDate}
        </div>
      </Container>
    </Navbar>
  );
}
