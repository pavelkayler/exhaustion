async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const obj = JSON.parse(text) as { message?: unknown; error?: unknown };
      const msg = obj.message ?? obj.error ?? "";
      return msg ? ` ${String(msg)}` : ` ${text}`;
    } catch {
      return ` ${text}`;
    }
  } catch {
    return "";
  }
}

type JsonRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

function withTimeout(options?: JsonRequestOptions): { signal?: AbortSignal; cleanup: () => void } {
  if (!(options?.timeoutMs && options.timeoutMs > 0)) {
    return { signal: options?.signal, cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "AbortError"));
  }, options.timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => window.clearTimeout(timer),
  };
}

async function parseJsonBody<T>(res: Response, url: string): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Empty response body for ${url}`);
  }
  if (!contentType.toLowerCase().includes("json")) {
    const compact = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`Expected JSON from ${url}, got ${contentType || "unknown content-type"}: ${compact}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${String(error?.message ?? error)}`);
  }
}

export async function getJson<T>(url: string, options?: JsonRequestOptions): Promise<T> {
  const { signal, cleanup } = withTimeout(options);
  try {
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new Error(`GET ${url} failed: ${res.status}${body}`);
    }
    return await parseJsonBody<T>(res, url);
  } finally {
    cleanup();
  }
}

export async function postJson<T>(url: string, body: unknown = {}, options?: JsonRequestOptions): Promise<T> {
  const { signal, cleanup } = withTimeout(options);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const bodyText = await readErrorBody(res);
      throw new Error(`POST ${url} failed: ${res.status}${bodyText}`);
    }
    return await parseJsonBody<T>(res, url);
  } finally {
    cleanup();
  }
}

export async function putJson<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const bodyText = await readErrorBody(res);
    throw new Error(`PUT ${url} failed: ${res.status}${bodyText}`);
  }
  return await parseJsonBody<T>(res, url);
}

export async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const bodyText = await readErrorBody(res);
    throw new Error(`DELETE ${url} failed: ${res.status}${bodyText}`);
  }
  return await parseJsonBody<T>(res, url);
}
