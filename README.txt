Что изменено

1. Из таблицы Positions убраны подписи BUY/SELL.
2. Добавлен второй столбец Reason.
3. Value и PnL теперь форматируются с $.
4. TP и SL отображаются как процент изменения цены от entry price позиции.
5. Текущий PnL больше не зависит только от private position updates:
   он пересчитывается на фронте в реальном времени по live market rows из основного ws feed.
6. В payload private positions добавлены поля:
   - reason
   - size
   - entryPrice
   - markPrice

Логика reason:
- если в row.reason / row.openReason / row.positionReason придет manual/candidate/final — берем его
- если orderLinkId содержит candidate или final — пробуем вывести reason из него
- иначе default = manual

Что заменить
- frontend/src/features/positions/hooks/usePrivatePositionsFeed.ts
- frontend/src/pages/shortExecution/ShortExecutionPage.tsx
- backend/src/api/privatePositionsWs.ts
