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
