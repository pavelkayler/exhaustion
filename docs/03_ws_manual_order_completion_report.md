# WS control plane completion report

## Что добавлено в архив

- frontend replacement: `frontend/src/shared/types/domain.ts`
- frontend replacement: `frontend/src/features/manualOrders/api/manualOrdersApi.ts`
- backend patch instructions: `backend/src/api/wsHub.ts.patch`

## Что доводится до WS

- `session.status`
- `session.start`
- `session.stop`
- `session.pause`
- `session.resume`
- `config.get`
- `config.update`
- `manual_order.submit`

## Что важно по manual order

Переводится только frontend transport и browser-to-server control plane.
Дальше backend всё равно может исполнять заявку через существующий REST/API path к бирже.
Это не противоречит миграции на WS control plane.

## Что не трогалось

- `GET /api/session/events/download`
- `GET /health`
- `POST /api/admin/shutdown`
- compat `POST /api/manual-test-order`
