import { HeaderBar } from "../HeaderBar";
import { useDashboardPageContext } from "../../context/DashboardPageContext";

export function DashboardHeaderSection() {
  const {
    conn,
    status,
    wsUrl,
    lastServerTime,
    streams,
    canStart,
    canStop,
    canPause,
    canResume,
    busy,
    start,
    stop,
    pause,
    resume,
  } = useDashboardPageContext();

  return (
    <HeaderBar
      conn={conn}
      sessionState={status.sessionState}
      runningBotName={status.runningBotName}
      wsUrl={wsUrl}
      lastServerTime={lastServerTime}
      streams={streams}
      canStart={canStart}
      canStop={canStop}
      busy={busy}
      onStart={() => void start()}
      onStop={() => void stop()}
      onPause={() => void pause()}
      onResume={() => void resume()}
      canPause={canPause}
      canResume={canResume}
    />
  );
}
