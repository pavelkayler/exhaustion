import { createHmac } from "node:crypto";
import { nowMs } from "./serverTimeOffset.js";

type SignedHeadersArgs = {
  apiKey: string;
  apiSecret: string;
  recvWindow: number;
  timestamp?: number;
  method: "GET" | "POST";
  queryString?: string;
  bodyString?: string;
};

export function buildSortedQueryString(query: Record<string, unknown>): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b));

  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function buildSignedHeaders(args: SignedHeadersArgs): Record<string, string> {
  const timestamp = args.timestamp ?? nowMs();
  const payload = args.method === "GET"
    ? (args.queryString ?? "")
    : (args.bodyString ?? "");

  const signBase = `${timestamp}${args.apiKey}${args.recvWindow}${payload}`;
  const sign = createHmac("sha256", args.apiSecret).update(signBase).digest("hex").toLowerCase();

  return {
    "X-BAPI-API-KEY": args.apiKey,
    "X-BAPI-TIMESTAMP": String(timestamp),
    "X-BAPI-RECV-WINDOW": String(args.recvWindow),
    "X-BAPI-SIGN": sign,
  };
}
