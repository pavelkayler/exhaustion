Что исправлено

- На execution-странице добавлен отдельный hook:
  - frontend/src/pages/shortExecution/hooks/useExecutionMarketRefresh.ts
- Он шлёт `rows_refresh_request("tick")` сразу при заходе на страницу и потом каждые 5 секунд.
- `ShortExecutionPage.tsx` только подключает этот hook и остаётся orchestration-слоем.

Зачем:
- PnL и Value в Positions считаются от market rows из основного ws feed.
- Если backend сам не прислал свежий tick, execution page теперь принудительно запрашивает обновление раз в 5 секунд.
- Это даёт ожидаемое обновление PnL без ручного изменения ордера/TP/SL на бирже.
