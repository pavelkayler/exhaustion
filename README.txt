Архив содержит полные изменённые файлы.

Что сделано:
1. Позиции теперь обновляются по private ws как source of truth по `unrealizedPnl`.
2. Убран отдельный public ws и REST reconcile для позиций из `privatePositionsWs.ts`.
3. Список ордеров по-прежнему можно подтянуть initial seed через API при старте/переподключении.
4. Раз в минуту backend делает resubscribe только на `position`.
5. Если resubscribe не дал нового position frame, следующая попытка будет на 2-й минуте, затем по минутной сетке.
6. Если с момента последнего успешного position refresh прошло 5 минут и было 4+ подряд fail, backend делает full reconnect private ws.
7. На фронте `PnL`/`Value` между private refresh'ами проецируются каждые 10 секунд от уже существующего market feed (`useWsFeed().rows`).
8. На 60-й секунде и дальше проекция останавливается и ждёт новый фактический `unrealizedPnl` из private ws.
9. После нового фактического position refresh цикл 10-секундной проекции начинается заново.

Что заменить:
- backend/src/api/privatePositionsWs.ts
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- frontend/src/pages/shortExecution/components/ExecutionPositionsCard.tsx
- frontend/src/pages/shortExecution/hooks/useExecutionProjectedPositions.ts
