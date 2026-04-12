import { getApiBase } from "../../../shared/config/env";
import type {
  ExecutorSettings,
  ExecutorStatusResponse,
} from "../../../shared/types/domain";

const apiBase = getApiBase();

async function httpJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      String(
        (data as { error?: unknown; message?: unknown } | null)?.message ??
          (data as { error?: unknown } | null)?.error ??
          `${response.status} ${response.statusText}`,
      ),
    );
  }

  return data as T;
}

export async function fetchExecutorStatus(): Promise<ExecutorStatusResponse> {
  return httpJson<ExecutorStatusResponse>("/api/executor/status");
}

export async function updateExecutorSettings(
  patch: Partial<ExecutorSettings>,
): Promise<ExecutorStatusResponse> {
  return httpJson<ExecutorStatusResponse>("/api/executor/settings", {
    method: "POST",
    body: JSON.stringify(patch ?? {}),
  });
}

export async function startExecutor(): Promise<ExecutorStatusResponse> {
  return httpJson<ExecutorStatusResponse>("/api/executor/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopExecutor(): Promise<ExecutorStatusResponse> {
  return httpJson<ExecutorStatusResponse>("/api/executor/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
