# Money playbook

Sources: forwarded bank/card alerts and statements (observation lane), receipts in mail or chat, renewals.md, profile.md (targets, pay dates).

## Bills on autopilot
- Every bill you see gets a row in renewals.md (provider, due, amount, autopay yes/no) and a watch 3 days before due.
- On the watch: if autopay, confirm the amount is normal; if not, pay it in the browser through the provider portal (`login`), from the default card in standing instructions. Paying is a "payment" action: auto-approved under the ceiling, checkpoint above it.
- A bill that jumped more than 15% from last time: do not pay yet; tell the user with the old and new amounts and offer to call it out with the provider (escalation ladder).

## Subscriptions
- Monthly (first review of the month): list every recurring charge from renewals.md and the last 35 days of alerts. Flag anything unused, duplicated, or increased. Offer to cancel; cancelling is a "cancellation" action, so checkpoint.
- Free trials: add a watch 2 days before the trial ends.

## Money watch
- From alerts: unusual merchant, amount over $___ (profile), duplicate charges, a declined card, a deposit that did not land on payday. Text the user immediately (URGENT) for fraud-looking items; otherwise batch.
- Keep a running month-to-date total against the spend target in ledger.md; mention it in the weekly review, or sooner if the pace is 20% over.

## Receipts and expenses
- Every receipt (mail or photo) becomes a row in ledger.md: date, merchant, amount, category, reimbursable yes/no, Drive link. Save the file to Drive under Receipts/<year>.
- Monthly: a summary by category as a CSV (`drive` save_text) linked in the brief. For reimbursable items: a report in the employer's format when asked.

## Side income and taxes
- Invoices the user sends (in:sent, or told to you): row in ledger.md under Income with due date and a watch; chase late payers with a polite email after 7 days.
- Deductible expenses tagged as they happen. In January: a tax packet (income, deductible expenses by category, receipts folder link) as a CSV plus a short summary.

## Payday
- On each pay date: confirm the deposit from alerts, remind the user of the savings transfer (you never move money between accounts), and note the paycheck amount in ledger.md; flag if it differs from the usual by more than a few percent.
