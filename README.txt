Архив частичный: содержит только файлы, которые нужно заменить/добавить для доведения control plane до WS.

Что внутри:
- frontend/src/shared/types/domain.ts
- frontend/src/features/manualOrders/api/manualOrdersApi.ts
- backend/src/api/wsHub.ts.patch

Как применять:
1. Распаковать архив поверх репозитория.
2. Заменить frontend-файлы из архива.
3. Применить инструкции из backend/src/api/wsHub.ts.patch к backend/src/api/wsHub.ts.
4. Прогнать сборку:
   - cd frontend && npm run build
   - cd ../backend && npm run build

Что переводится на WS после применения:
- session.status
- session.start
- session.stop
- session.pause
- session.resume
- config.get
- config.update
- manual_order.submit

Что намеренно остаётся на HTTP:
- /api/session/events/download
- /health
- /api/admin/shutdown
- compat /api/manual-test-order

Примечание:
manual order с фронта пойдёт по WS-RPC, но сервер всё равно может дальше ходить к бирже по REST/API через текущий runtime/broker path. Это нормально.
