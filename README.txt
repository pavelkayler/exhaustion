Что исправлено

Корень бага:
- `ExecutionPositionsCard` поверх backend execution snapshot заново пересчитывал `Value` и `PnL`
  из `useWsFeed().rows`
- из-за этого UI зависел не от живого execution-feed, а от того, когда обновятся именно `rows`
- поэтому:
  - timestamp мог обновляться
  - а `PnL` оставался старым
  - после reload мог показываться старый/неверный `PnL`

Что сделано:
- `ShortExecutionPage.tsx` больше не тянет `rows` и не передаёт их в positions card
- `ExecutionPositionsCard.tsx` теперь использует backend execution snapshot как source of truth:
  - `row.value`
  - `row.pnl`
  - `updatedAt`
- frontend больше не перетирает значения своим локальным пересчётом

Что заменить:
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- frontend/src/pages/shortExecution/components/ExecutionPositionsCard.tsx
