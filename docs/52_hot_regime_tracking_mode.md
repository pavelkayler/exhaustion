# Hot Regime Tracking Mode

## Summary

The short-exhaustion workflow now has two switchable tracking modes:

- `legacy mode` keeps the existing behavior unchanged
- `hot regime mode` adds a more persistent, candidate-first tracking path for pumped altcoins

Hot regime mode does **not** replace legacy mode.
It is a parallel mode meant to preserve practical local-pump Candidate recall while improving symbol persistence and repeated-candidate handling.

## Legacy Mode

Legacy mode remains the default.

When `botConfig.observe.useHotRegimeTracking` is `false`:

- the current top100 by open interest flow stays in place
- the current legacy signal states and meanings stay in place
- `Final`, `Soft Final`, and `Fast Scalp` remain unchanged
- the current refresh cadence remains unchanged

## Hot Regime Mode

When `botConfig.observe.useHotRegimeTracking` is `true`:

- the universe switches to `bybit-linear-usdt-open-interest-top200`
- the universe refreshes every 15 minutes
- ranking still comes from one Bybit linear tickers REST call and is built locally
- candidate-capable tracking stays available across the full top200

This mode is intended for a candidate-first pump-fade workflow:

- the first short candidate does not need to be the exact top tick
- the same symbol can stay relevant for a long time inside one volatile regime
- repeated candidate windows on the same symbol are intentionally allowed
- recall and persistence are prioritized over aggressive stream reduction

## Hot Regime Semantics

In hot regime mode:

- `WATCHLIST` acts as a sticky hot-symbol regime state
- symbols are kept relevant for at least 30 minutes once the hot regime is active
- renewed activity extends the hot regime window
- brief quiet pauses do not immediately evict the symbol
- exact duplicate candidate spam is still suppressed
- renewed candidate windows during the same broader regime are allowed

Candidate meaning is broader in this mode:

- a Candidate is a workable short-setup phase inside a longer volatile regime
- the mode is not meant to become stricter than legacy on overlapping local-pump setups that legacy already catches

## UI

The Short Signals page includes a switch labeled `Hot regime mode`.

- `OFF` = legacy tracking
- `ON` = hot-regime top200 tracking

The switch sits beside the existing `hide rejected` control and persists through the normal backend config flow.

## Intentional Non-Scope

This task intentionally did **not** add:

- portfolio correlation controls
- a redesign of the existing page
- a destructive rewrite of the legacy signal path
