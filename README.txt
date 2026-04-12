Что исправлено

Причина бага:
- execution-таблица брала market data из `rows`
- но пересчёт был завязан только на ссылку `rows`
- когда backend обновлял market state без новой ссылки на массив rows, `PnL` и `Value` не пересчитывались
- timestamp в header тоже жил отдельно от market refresh и поэтому не обновлялся вместе с PnL

Что изменено:
- `ShortExecutionPage.tsx` теперь передаёт в `ExecutionPositionsCard` ещё и `lastServerTime` как `marketUpdatedAt`
- `ExecutionPositionsCard.tsx`:
  - считает `effectiveUpdatedAt = max(updatedAt, marketUpdatedAt)`
  - использует `marketUpdatedAt` в зависимостях `useMemo`
  - поэтому пересчёт `PnL`/`Value` и надпись `updated` синхронизируются с каждым market refresh

Что заменить:
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- frontend/src/pages/shortExecution/components/ExecutionPositionsCard.tsx
