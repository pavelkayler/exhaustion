import type { ConfigResponse, RuntimeConfig } from "../../../shared/types/domain";
import { requestWsRpc } from "../../ws/hooks/useWsFeed";

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const res = await requestWsRpc<ConfigResponse>("config.get");
  return res.config;
}

export async function updateRuntimeConfig(
  patch: Partial<RuntimeConfig>,
): Promise<ConfigResponse> {
  return requestWsRpc<ConfigResponse>("config.update", patch);
}
