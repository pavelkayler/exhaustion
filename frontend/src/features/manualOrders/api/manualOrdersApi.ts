import type { ManualTestOrderResponse } from "../../../shared/types/domain";
import { requestWsRpc } from "../../ws/hooks/useWsFeed";

export async function submitManualTestOrder(payload: {
  symbol: string;
  side: "LONG" | "SHORT";
  executionMode: "demo" | "real";
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  marginUSDT?: number;
  leverage?: number;
}): Promise<ManualTestOrderResponse> {
  return requestWsRpc<ManualTestOrderResponse>("manual_order.submit", payload);
}
