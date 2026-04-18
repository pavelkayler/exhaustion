# Aggressive pump-fade presets

## Why these presets were added

The current short strategy is Candidate-first:

- find a coin that already pumped
- open a short looking for a pullback
- if price keeps moving up, allow controlled averaging with two additional equal-value entries
- keep TP at 5% from the **current average entry**, so TP moves after averaging

Because of that workflow, the first entry does not need perfect top-tick precision.
The user asked for presets that intentionally produce more Candidate signals than `Pump Fade Balanced` and `Pump Fade Strict`, while still filtering out completely dead or thin symbols.

This task adds two more aggressive built-in presets without changing:

- Final logic
- Derivatives logic
- Exhaustion logic
- Microstructure logic
- execution or broker behavior

## New built-in presets

- `pump_fade_aggressive` — `Pump Fade Aggressive`
- `pump_fade_high_frequency` — `Pump Fade High Frequency`

Both presets override **only Candidate thresholds**.
Derivatives / Exhaustion / Microstructure / Observe remain inherited from normalized defaults.

## Pump Fade Aggressive

Candidate values:

- `minPriceMove1mPct: 0.75`
- `minPriceMove3mPct: 1.6`
- `minPriceMove5mPct: 2.8`
- `minPriceMove15mPct: 4.8`
- `minVolumeBurstRatio: 1.9`
- `minTurnoverBurstRatio: 1.9`
- `maxUniverseRank: 5`
- `minTurnover24hUsd: 20000000`
- `maxTurnover24hUsd: null`
- `minOpenInterestValueUsd: 3500000`
- `minTrades1m: 35`
- `maxSpreadBps: 24`
- `minDistanceFromLow24hPct: 6`
- `minNearDepthUsd: 20000`
- `candidateScoreMin: 1.18`

When to use:

- when `Balanced` feels too selective
- when you still want a reasonable liquidity and activity floor
- when you want more setups but not the loosest possible scan

## Pump Fade High Frequency

Candidate values:

- `minPriceMove1mPct: 0.65`
- `minPriceMove3mPct: 1.35`
- `minPriceMove5mPct: 2.4`
- `minPriceMove15mPct: 4.2`
- `minVolumeBurstRatio: 1.75`
- `minTurnoverBurstRatio: 1.75`
- `maxUniverseRank: 6`
- `minTurnover24hUsd: 15000000`
- `maxTurnover24hUsd: null`
- `minOpenInterestValueUsd: 2500000`
- `minTrades1m: 28`
- `maxSpreadBps: 26`
- `minDistanceFromLow24hPct: 5`
- `minNearDepthUsd: 16000`
- `candidateScoreMin: 1.05`

When to use:

- when the goal is to maximize Candidate flow for the averaging-based pump-fade strategy
- when you accept more imperfect first entries
- when you still want to avoid the weakest symbols, but prefer frequency over selectivity

## Notes

- These presets are intentionally looser than `Pump Fade Balanced` and `Pump Fade Strict`
- They are meant for the workflow where controlled averaging can improve average entry if the first signal is not perfect
- TP still remains 5% from the current average position entry
- Final logic was intentionally not changed in this task
