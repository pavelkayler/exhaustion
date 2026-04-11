Что изменено

1. `ShortExecutionPage.tsx` разрезан на маленькие компоненты:
- `ExecutionHeaderCard.tsx`
- `ExecutionPositionsCard.tsx`
- `ExecutionOrdersCard.tsx`
- `ExecutionSettingsCard.tsx`
- `executionUi.ts`
- `model.ts`

2. Страница execution теперь только orchestration-слой:
- тянет хуки
- хранит local settings
- импортирует и собирает маленькие блоки

3. В Placed Orders добавлен столбец `Value` третьим.

4. Денежные значения теперь со знаком `$` справа.

5. В orders feed остаются только limit order'ы.

6. Backend execution feed исправлен:
- подписка теперь на `position`, `order`, `execution`
- при `execution` / завершении order state делается reconcile через REST
- это помогает убрать закрытые вручную позиции и не держать stale rows
- reconcile задросселен, не чаще одного запуска в секунду
- live `PnL` и `Value` для positions считаются на фронте по `useWsFeed().rows`, а не только по execution ws snapshot

Что заменить
- frontend/src/features/positions/hooks/usePrivatePositionsFeed.ts
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- frontend/src/pages/shortExecution/model.ts
- frontend/src/pages/shortExecution/components/ExecutionHeaderCard.tsx
- frontend/src/pages/shortExecution/components/ExecutionPositionsCard.tsx
- frontend/src/pages/shortExecution/components/ExecutionOrdersCard.tsx
- frontend/src/pages/shortExecution/components/ExecutionSettingsCard.tsx
- frontend/src/pages/shortExecution/components/executionUi.ts
- backend/src/api/privatePositionsWs.ts
