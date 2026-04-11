import { Badge, Card } from "react-bootstrap";

type Props = {
  mode: "demo" | "real";
  feedStatus: string;
};

export function ExecutionHeaderCard({ mode, feedStatus }: Props) {
  return (
    <Card className="genesis-card mb-3">
      <Card.Body className="py-2 px-3 d-flex align-items-center justify-content-between gap-3 flex-wrap">
        <div className="fw-semibold">Execution</div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <Badge bg={mode === "real" ? "danger" : "warning"}>mode: {mode}</Badge>
          <small className="text-secondary">positions feed: {feedStatus}</small>
        </div>
      </Card.Body>
    </Card>
  );
}
