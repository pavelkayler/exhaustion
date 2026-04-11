import { getApiBase } from "../../../shared/config/env";
import { getJson, postJson } from "../../../shared/api/http";
import type { ConfigResponse, RuntimeConfig } from "../../../shared/types/domain";

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const base = getApiBase();
  const res = await getJson<ConfigResponse>(`${base}/api/config`);
  return res.config;
}

export async function updateRuntimeConfig(patch: Partial<RuntimeConfig>): Promise<ConfigResponse> {
  const base = getApiBase();
  const res = await postJson<ConfigResponse>(`${base}/api/config`, patch);
  return res;
}
