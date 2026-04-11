export type MarketStreamsRuntimeStatus = {
  streamsEnabled: boolean;
  bybitConnected: boolean;
  updatedAtMs: number | null;
};

const state: MarketStreamsRuntimeStatus = {
  streamsEnabled: false,
  bybitConnected: false,
  updatedAtMs: null,
};

export function getMarketStreamsRuntimeStatus(): MarketStreamsRuntimeStatus {
  return { ...state };
}

export function setMarketStreamsRuntimeStatus(next: {
  streamsEnabled: boolean;
  bybitConnected: boolean;
}): MarketStreamsRuntimeStatus {
  state.streamsEnabled = Boolean(next.streamsEnabled);
  state.bybitConnected = Boolean(next.bybitConnected);
  state.updatedAtMs = Date.now();
  return getMarketStreamsRuntimeStatus();
}
