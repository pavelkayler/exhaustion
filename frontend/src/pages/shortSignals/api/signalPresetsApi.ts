import { getApiBase } from "../../../shared/config/env";
import type { SignalPresetsResponse, SignalThresholds } from "../../../shared/types/domain";

const apiBase = getApiBase();

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(String((data as { error?: unknown } | null)?.error ?? response.statusText));
  }
  return data as T;
}

export async function fetchSignalPresets(): Promise<SignalPresetsResponse> {
  const response = await fetch(`${apiBase}/api/signals/presets`, {
    credentials: "same-origin",
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(String((data as { error?: unknown } | null)?.error ?? response.statusText));
  }
  return data as SignalPresetsResponse;
}

export async function saveSignalPreset(args: {
  id?: string | null;
  name: string;
  thresholds: SignalThresholds;
}): Promise<SignalPresetsResponse> {
  return postJson<SignalPresetsResponse>("/api/signals/presets/save", args);
}

export async function deleteSignalPreset(id: string): Promise<SignalPresetsResponse> {
  return postJson<SignalPresetsResponse>("/api/signals/presets/delete", { id });
}

export async function applySignalPreset(args: {
  selectedPresetId?: string | null;
  thresholds: SignalThresholds;
}): Promise<SignalPresetsResponse> {
  return postJson<SignalPresetsResponse>("/api/signals/presets/apply", args);
}
