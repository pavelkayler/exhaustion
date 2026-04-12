Проверено по актуальному main в подключённом репозитории: текущий backend execution feed на старте и после subscribe вызывал один и тот же `seedFromRest`, который подтягивал и ордера, и позиции, а потом полностью перезаписывал оба map. Из-за этого private `position` snapshot мог быть затёрт пустым REST-результатом, и позиция появлялась только после последующего order/execution reconcile.

Что изменено:
- `backend/src/api/privatePositionsWs.ts`
- REST bootstrap/reconcile теперь касается только ордеров:
  - `seedFromRest` заменён на `seedOrdersFromRest`
  - из REST больше не читаются позиции вообще
- `positions` остаются только источником из private ws `position`
- initial orders seed через API оставлен как был по сути
- subsequent order/execution reconcile тоже обновляет только orders
- current public ticker socket для расчёта value/pnl не трогался

Ожидаемый эффект:
- при subscribe пришедший private `position` snapshot больше не будет затираться пустым REST bootstrap
- ордера продолжат появляться на старте как раньше
- позиции должны появляться именно из private подписки, без ожидания отмены ордера
