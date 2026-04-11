export function getApiBase(): string {
  const env = import.meta.env?.VITE_API_BASE;
  if (env && typeof env === "string" && env.length > 0) return env;
  return `http://${window.location.hostname}:8080`;
}

export function getWsUrl(): string {
  const env = import.meta.env?.VITE_WS_URL;
  if (env && typeof env === "string" && env.length > 0) return env;

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:8080/ws`;
}

export function getPrivatePositionsWsUrl(mode: "demo" | "real"): string {
  const env = import.meta.env?.VITE_POSITIONS_WS_URL;
  const base = env && typeof env === "string" && env.length > 0 ? env : getWsUrl();
  const url = new URL(base);

  url.pathname = "/ws/private-positions";
  url.searchParams.set("mode", mode);

  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";

  return url.toString();
}
