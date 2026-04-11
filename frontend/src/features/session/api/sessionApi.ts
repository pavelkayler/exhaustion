import { getApiBase } from "../../../shared/config/env";
import type { StatusResponse } from "../../../shared/types/domain";
import { requestWsRpc } from "../../ws/hooks/useWsFeed";

export async function fetchStatus(): Promise<StatusResponse> {
  return requestWsRpc<StatusResponse>("session.status");
}

export type StartSessionPayload = Partial<{
  selectedBotId: string;
  selectedBotPresetId: string;
  selectedExecutionProfileId: string;
}>;

export async function startSession(
  payload?: StartSessionPayload,
): Promise<StatusResponse> {
  return requestWsRpc<StatusResponse>("session.start", payload ?? {});
}

export async function stopSession(): Promise<StatusResponse> {
  return requestWsRpc<StatusResponse>("session.stop", {});
}

export async function pauseSession(): Promise<StatusResponse> {
  return requestWsRpc<StatusResponse>("session.pause", {});
}

export async function resumeSession(): Promise<StatusResponse> {
  return requestWsRpc<StatusResponse>("session.resume", {});
}

export function getEventsDownloadUrl(): string {
  const api = getApiBase();
  return `${api}/api/session/events/download`;
}
