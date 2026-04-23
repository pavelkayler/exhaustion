# Hot Regime Mode Top200 Progress Report

## Summary

1. Added persisted short-signal mode flag `botConfig.observe.useHotRegimeTracking` with default `false`.
2. Kept the legacy mode path intact and added a parallel hot-regime mode path instead of replacing it.
3. Generalized the top open-interest universe refresh logic to support:
   - legacy mode: top100 by OI, hourly refresh
   - hot regime mode: top200 by OI, 15-minute refresh
4. Added hot-regime state handling that keeps symbols sticky for longer, allows renewed candidate windows, and avoids turning the new mode into a stricter replacement.
5. Added the Short Signals UI switch `Hot regime mode` beside `hide rejected`.
6. Added focused backend tests for config persistence, universe mode settings, hot-regime repeat behavior, and hot-mode full-top200 topic coverage.
7. Added docs for the new mode and linked them from the cleanup report.

## Files Changed

- `backend/src/api/shortHotRegimeTracking.ts`
- `backend/src/api/wsHub.ts`
- `backend/src/bots/registry.ts`
- `backend/src/runtime/topOpenInterestUniverse.ts`
- `backend/src/tests/configStore.hotRegimeTracking.test.ts`
- `backend/src/tests/shortHotRegimeTracking.test.ts`
- `backend/src/tests/topOpenInterestUniverse.test.ts`
- `backend/src/tests/wsHub.hotRegimeSubscriptions.test.ts`
- `frontend/src/pages/shortSignals/ShortSignalsPage.tsx`
- `frontend/src/shared/types/domain.ts`
- `docs/01_cleanup_report.md`
- `docs/52_hot_regime_tracking_mode.md`
- `progress/01_hot_regime_mode_top200.md`

## Tests Added

1. Config store default and persistence round-trip for `useHotRegimeTracking`.
2. Universe mode settings for legacy vs hot-regime mode.
3. Hot-regime sticky watchlist behavior and renewed candidate allowance.
4. Hot-mode subscription topic coverage across the full top200 candidate-capable symbol set.

## Build And Test Results

- Backend `npm test`: passed
- Backend `npm run build`: passed
- Frontend `npm run build`: passed

## Intentionally Deferred

1. Portfolio correlation and overfill controls were intentionally left out of scope.
2. No broad engine rewrite was attempted.
3. No page redesign was attempted.
