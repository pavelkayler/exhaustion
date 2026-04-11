Что изменено

1. На странице Execution добавлена новая таблица Placed Orders сразу под Positions.
2. Столбцы Orders:
   - Symbol
   - Reason
   - Margin
   - Leverage
   - Entry Price
   - Placed
3. Placed форматируется в часовом поясе Москвы.
4. Значок $ перенесён вправо у денежных значений.
5. backend private execution feed теперь:
   - seed'ит текущие позиции через REST
   - seed'ит текущие открытые ордера через REST
   - подписывается на private topics: position + order
   - подписывается на public tickers по символам открытых позиций/ордеров
   - пересчитывает live PnL/Value не чаще раза в секунду через broadcast cadence

Что заменить
- frontend/src/features/positions/hooks/usePrivatePositionsFeed.ts
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- backend/src/api/privatePositionsWs.ts
