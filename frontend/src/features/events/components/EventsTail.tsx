import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Form, Table } from "react-bootstrap";
import { getApiBase } from "../../../shared/config/env";
import { fmtTime } from "../../../shared/utils/format";
import type { LogEvent } from "../../../shared/types/domain";

type Props = {
  enabled: boolean;
  events: LogEvent[];
  onRequestTail: (limit: number) => void;
};

function safeStr(v: unknown): string {
  if (v == null) return "";
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function eventRowKey(event: LogEvent): string {
  const payload = safeStr(event.payload);
  return `${Number(event.ts ?? 0)}|${String(event.type ?? "")}|${String(event.symbol ?? "")}|${payload}`;
}

export function EventsTail({ enabled, events, onRequestTail }: Props) {
  const [limit, setLimit] = useState(5);

  useEffect(() => {
    if (!enabled) return;
    onRequestTail(5);
  }, [enabled, onRequestTail]);

  const downloadUrl = useMemo(() => {
    const base = getApiBase();
    return `${base}/api/session/events/download`;
  }, []);

  return (
    <Card className="mt-3">
      <Card.Header className="d-flex align-items-center gap-2 flex-wrap">
        <b>Events (tail)</b>
        <Badge bg="secondary">limit: {limit}</Badge>
        <Badge bg="secondary">count: {events.length}</Badge>

        <div className="ms-auto d-flex align-items-center gap-2">
          <Form.Select
            size="sm"
            value={limit}
            style={{ width: 88 }}
            disabled={!enabled}
            onChange={(e) => {
              const next = Number(e.currentTarget.value);
              setLimit(next);
              onRequestTail(next);
            }}
          >
            <option value={5}>5</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </Form.Select>

          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() =>
              window.open(downloadUrl, "_blank", "noopener,noreferrer")
            }
          >
            Download jsonl
          </Button>
        </div>
      </Card.Header>

      <Card.Body>
        {!events.length ? (
          <div style={{ opacity: 0.75 }}>No events.</div>
        ) : (
          <Table
            striped
            bordered
            hover
            size="sm"
            style={{ tableLayout: "fixed", width: "100%" }}
          >
            <thead>
              <tr>
                <th style={{ width: "16%", fontSize: 12 }}>Time</th>
                <th style={{ width: "16%", fontSize: 12 }}>Type</th>
                <th style={{ width: "14%", fontSize: 12 }}>Symbol</th>
                <th style={{ width: "54%", fontSize: 12 }}>Payload</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={eventRowKey(ev)}>
                  <td
                    style={{
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {ev.ts ? fmtTime(ev.ts) : "—"}
                  </td>
                  <td
                    style={{
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {ev.type ?? "—"}
                  </td>
                  <td
                    style={{
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {ev.symbol ?? "—"}
                  </td>
                  <td
                    style={{
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {safeStr(ev.payload)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  );
}
