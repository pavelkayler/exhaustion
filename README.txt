Это replacement-архив без patch-текстов.

Что внутри:
- frontend/src/features/ws/hooks/useWsFeed.ts
- frontend/src/features/session/api/sessionApi.ts
- frontend/src/features/config/api/configApi.ts
- frontend/src/features/manualOrders/api/manualOrdersApi.ts

Что сделано:
- добавлен export `requestWsRpc`
- transport для `session.*`, `config.*`, `manual_order.submit` теперь идет через единый `requestWsRpc`
- если backend уже умеет `rpc_request/rpc_result`, будет использован WS-RPC
- если backend еще не умеет WS-RPC, автоматически используется текущий HTTP fallback:
  - /api/session/*
  - /api/config
  - /api/manual-test-order

Это означает:
- архив применяется сразу
- текущий crash из-за отсутствующего `requestWsRpc` исчезает
- ничего не ломается на текущем backend
- когда backend будет доведен до нативного WS-RPC, этот frontend начнет использовать его без новых правок

Что я не делал:
- не прикладывал patch-тексты
- не менял backend-файлы в этом архиве
- не прогонял сборку локально
