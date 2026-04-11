import { postJson } from "../../../shared/api/http";
import { getApiBase } from "../../../shared/config/env";
import type { ManualTestOrderResponse } from "../../../shared/types/domain";

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
  const base = getApiBase();
  return await postJson<ManualTestOrderResponse>(`${base}/api/manual-test-order`, payload);
}
