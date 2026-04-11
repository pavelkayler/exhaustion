import { Badge, Card } from "react-bootstrap";
import { fmtMoney, formatFee } from "../../../shared/utils/format";
import type { BotStats } from "../../../shared/types/domain";

type Props = {
  sessionState: "STOPPED" | "RUNNING" | "STOPPING" | "PAUSED" | "PAUSING" | "RESUMING";
  botStats: BotStats;
  uptimeText: string | null;
};

function pct(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return `${v.toFixed(2)}%`;
}

function timeAgo(tsMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "-";
  const deltaSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  if (deltaSec >= 60) return `${Math.floor(deltaSec / 60)}m ago`;
  return `${deltaSec}s ago`;
}

function fmtUsdt(value: number | null | undefined): string {
  return value == null ? "-" : `${value.toFixed(2)} USDT`;
}

export function BotSummaryBar({ sessionState, botStats, uptimeText }: Props) {
  const total = botStats.closedTrades;
  const winRate = total > 0 ? (botStats.wins / total) * 100 : 0;
  const brokerStats = botStats.executionMode === "demo"
    ? botStats.demoStats
    : botStats.executionMode === "real"
      ? botStats.realStats
      : null;
  const isBrokerMode = !!brokerStats;
  const balanceDelta =
    brokerStats
      && brokerStats.startBalanceUsdt != null
      && brokerStats.currentBalanceUsdt != null
      ? brokerStats.currentBalanceUsdt - brokerStats.startBalanceUsdt
      : null;

  const stateBadge =
    sessionState === "RUNNING" ? <Badge bg="success">{`RUNNING${uptimeText ? ` | ${uptimeText}` : ""}`}</Badge> :
    sessionState === "STOPPING" || sessionState === "PAUSING" || sessionState === "RESUMING" ? <Badge bg="warning">{sessionState}</Badge> :
    sessionState === "PAUSED" ? <Badge bg="secondary">PAUSED</Badge> :
    <Badge bg="secondary">STOPPED</Badge>;

  return (
    <Card className="mb-3">
      <Card.Header className="d-flex align-items-center gap-2 flex-wrap">
        <b>Bot stats</b>
        {stateBadge}
      </Card.Header>

      <Card.Body style={{ fontSize: 13 }}>
        <div className="d-flex flex-wrap gap-3">
          <div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>Positions</div>
            <div>open: {botStats.openPositions} | pending: {botStats.pendingOrders}</div>
          </div>

          <div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>PnL</div>
            <div>u: {fmtMoney(botStats.unrealizedPnl)} | r: {fmtMoney(botStats.netRealized)}</div>
          </div>

          <div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>Closed trades</div>
            <div>
              {botStats.closedTrades} (W {botStats.wins} / L {botStats.losses}) | win: {pct(winRate)}
            </div>
          </div>

          <div>
            <div style={{ opacity: 0.75, fontSize: 12 }}>Fees / Funding</div>
            <div>{formatFee(botStats.feesPaid)} / {fmtMoney(botStats.fundingAccrued)}</div>
          </div>

          {isBrokerMode ? (
            <>
              <div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>Broker global</div>
                <div>
                  pos: {brokerStats?.globalOpenPositions ?? 0} | ord: {brokerStats?.globalOpenOrders ?? 0}
                </div>
              </div>

              <div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>Pending / Reconcile</div>
                <div>
                  {brokerStats?.pendingEntries ?? 0} | {timeAgo(brokerStats?.lastReconcileAtMs ?? 0)}
                </div>
              </div>

              <div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>Balance</div>
                <div>{fmtUsdt(brokerStats?.currentBalanceUsdt)}</div>
              </div>

              <div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>Start / Delta</div>
                <div>{fmtUsdt(brokerStats?.startBalanceUsdt)} | {fmtMoney(balanceDelta)}</div>
              </div>

              <div>
                <div style={{ opacity: 0.75, fontSize: 12 }}>Exec / Balance update</div>
                <div>{timeAgo(brokerStats?.lastExecTimeMs ?? 0)} | {timeAgo(brokerStats?.currentBalanceUpdatedAtMs ?? 0)}</div>
              </div>
            </>
          ) : null}
        </div>
      </Card.Body>
    </Card>
  );
}
