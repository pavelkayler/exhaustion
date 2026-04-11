Причина:
- основной /ws на backend уже занят wsHub
- private positions через тот же HTTP server продолжал конфликтовать по upgrade routing
- поэтому /execution видел reconnect loop на ws://localhost:8080/ws/private-positions

Что исправлено:
- positions websocket вынесен на отдельный backend port
- frontend по умолчанию подключается к ws://<host>:8081/ws/private-positions?mode=...
- основной /ws на 8080 не затрагивается

Что заменить:
- frontend/src/shared/config/env.ts
- backend/src/api/privatePositionsWs.ts
- backend/.env.example

После замены:
1. перезапустить backend
2. убедиться, что backend поднял отдельный positions ws на 8081
3. перезапустить frontend
