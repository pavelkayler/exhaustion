Архив содержит полные изменённые файлы без patch-текстов.

Что входит:
- frontend/src/shared/config/env.ts
- frontend/src/features/ws/hooks/useWsFeed.ts
- frontend/src/features/session/api/sessionApi.ts
- frontend/src/features/config/api/configApi.ts
- frontend/src/features/manualOrders/api/manualOrdersApi.ts
- frontend/src/features/events/components/EventsTail.tsx
- frontend/src/features/positions/hooks/usePrivatePositionsFeed.ts
- frontend/src/pages/shortSignals/ShortSignalsPage.tsx
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- backend/src/api/privatePositionsWs.ts
- backend/src/index.ts
- backend/.env.example

Что сделано:
1. EventsTail теперь при первом открытии реально запрашивает limit=5.
2. На Short Signals один глобальный hide rejected в отдельной узкой шапке под HeaderBar.
3. На Short Execution добавлен верхний полноширинный блок Positions.
4. Positions тянутся с фронта на backend по отдельному websocket /ws/private-positions.
5. Backend тянет private positions с Bybit по private websocket, а в браузер шлёт снимок не чаще 1 раза в секунду.
6. Добавлен backend/.env.example с ключами для real/demo аккаунтов.

Что не проверял:
- локальную сборку не запускал
- live-подключение к Bybit не тестировал
