# Candidate threshold fix and pump-fade presets

## What the bug was

`backend/src/engine/ShortExhaustionSignalEngine.ts` assembled Candidate thresholds through helpers such as:

- `minCeil(value, relaxedCeil)` using `Math.min(...)`
- `maxFloor(value, relaxedFloor)` using `Math.max(...)`

That logic silently relaxed user-configured Candidate filters.

Examples of the bad behavior:

- raising `minTrades1m` could still fall back to a softer internal value
- raising `candidateScoreMin` could still be cut back down
- lowering `maxSpreadBps` could still be widened again
- lowering `maxUniverseRank` could still be expanded again

This made the UI imply a stricter Candidate filter than the engine actually used.

## What changed

Candidate threshold assembly now honors the normalized config directly instead of auto-softening it.

Changed behavior:

- Candidate minimum thresholds now stay at the configured value
- Candidate maximum thresholds now stay at the configured value
- only true safety normalization remains where it does not make filtering looser

This task intentionally did **not** change:

- Final logic
- Derivatives logic
- Exhaustion logic
- Microstructure logic
- soft-final behavior
- fast-scalp behavior
- execution/broker behavior

## Built-in presets added

Two built-in presets are now seeded by code in the signal preset store:

- `pump_fade_balanced` — `Pump Fade Balanced`
- `pump_fade_strict` — `Pump Fade Strict`

They are Candidate-oriented presets for the current pump-fade short strategy.

The strategy is Candidate-first:

- identify already stretched pumps
- short the pullback attempt
- use averaging only as a controlled error buffer
- keep TP dynamic from average entry
- keep per-symbol loss bounded through the execution layer

Because of that, these presets only change **Candidate** thresholds.
Derivatives / Exhaustion / Microstructure / Observe stay inherited from normalized defaults.

## Pump Fade Balanced candidate values

- `minPriceMove1mPct: 0.9`
- `minPriceMove3mPct: 2.0`
- `minPriceMove5mPct: 3.8`
- `minPriceMove15mPct: 6.0`
- `minVolumeBurstRatio: 2.2`
- `minTurnoverBurstRatio: 2.2`
- `maxUniverseRank: 3`
- `minTurnover24hUsd: 35000000`
- `maxTurnover24hUsd: null`
- `minOpenInterestValueUsd: 5000000`
- `minTrades1m: 50`
- `maxSpreadBps: 20`
- `minDistanceFromLow24hPct: 8`
- `minNearDepthUsd: 30000`
- `candidateScoreMin: 1.40`

## Pump Fade Strict candidate values

- `minPriceMove1mPct: 1.0`
- `minPriceMove3mPct: 2.2`
- `minPriceMove5mPct: 4.2`
- `minPriceMove15mPct: 6.5`
- `minVolumeBurstRatio: 2.4`
- `minTurnoverBurstRatio: 2.4`
- `maxUniverseRank: 3`
- `minTurnover24hUsd: 45000000`
- `maxTurnover24hUsd: null`
- `minOpenInterestValueUsd: 6000000`
- `minTrades1m: 60`
- `maxSpreadBps: 18`
- `minDistanceFromLow24hPct: 9`
- `minNearDepthUsd: 40000`
- `candidateScoreMin: 1.48`
