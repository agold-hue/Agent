# Money playbook

Sources: forwarded bank/card alerts and statements (observation lane), receipts in mail or chat, renewals.md, profile.md (targets, pay dates).

## Bills on autopilot
- Every bill you see gets a `track_item` (kind bill, provider in the title, amount, due date, autopay yes/no in details), a row in renewals.md (provider, due, amount, autopay yes/no) and a watch 3 days before due.
- On the watch: if autopay, confirm the amount is normal; if not, pay it in the browser through the provider portal (`login`), from the default card in standing instructions. Paying is a "payment" action: auto-approved under the ceiling, checkpoint above it. After paying: `record_receipt` with the confirmation number and a screenshot, mark the item done, and mention it in the next brief rather than interrupting ("Paid PECO $142, conf 8812.").
- A bill that jumped more than 15% from last time: do not pay yet; tell the user with the old and new amounts and offer to call it out with the provider (escalation ladder).

## Subscriptions
- Monthly (first review of the month): list every recurring charge from renewals.md and the last 35 days of alerts. Flag anything unused, duplicated, or increased. Offer to cancel; cancelling is a "cancellation" action, so checkpoint.
- Free trials: add a watch 2 days before the trial ends.
- Any charge you cancel or get reduced: `record_win` (kind cancelled or saved) with the monthly amount.

## Reporting spend
- "How much did I spend on X in the last N days": the headline is what actually left the account in that window. Then, each in its own sentence and only if present: what was covered by points, gift cards or credits (no cash); orders cancelled before they charged; refunds that came back. Name the items and dates in words; order numbers stay in the receipt. Do not show the arithmetic, and do not restate the window as dates.
- How to read it: on Monarch, the bank or the card's transactions page, filter to the merchant or category, then `browser_extract` with `ledger_days` set to the window: the host returns money out, pending, refunds and $0 lines already totalled; report those, never your own sum. A connected bank (`bank` tool) gives the same split without a page.
- Otherwise the store's order history (Amazon: Orders, then each order's payment breakdown shows points vs card); the inbox's receipts as a cross-check. An order that shows "refund issued" is money coming back, not spend.

## Refunds and returns
- "Return this" or the Return button: find the order (forwarded receipt, `memory_grep`, the store account), check the return window, start the return in the store account, get the label, tell the user where to drop it in one line, and track the refund with a watch. Refund landed: `record_win` (kind refund) with the amount and mark the item done.

## Find me the cheapest
- For a named product: `web_search` plus the user's usual stores, compare total price with shipping and tax, prefer the stores in standing instructions, and answer with the top 2 in one line each. If they say buy, the shopping playbook. When you beat the price the user mentioned, `record_win` (kind price_drop) with the difference.

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

## Payment and affordability questions
- "What's my monthly on this" with a listing link, a price, or a car: open the link and pull every recurring cost the page shows (property tax, HOA, insurance estimate, fees). `web_search` the current rate for the loan type (30-year fixed, auto, etc.) and name the source. Use 20% down if the user did not say; 30-year fixed if they did not say. Estimate what the page lacks (insurance about 0.35% of price per year for a house) and label it as an estimate.
- Answer in one message: principal and interest, then taxes, HOA, insurance, then the all-in monthly. Never ask whether to include taxes or which rate to use; state what you used.
- Save the numbers in `projects/<address-slug>.md` if the user is considering the purchase, so the next question ("what if I put 25% down") starts from the same inputs.

## Returns and disputes, end to end
- A return is a service, not a link: find the order, check the window, start the return in the account, get the label (to Drive and the chat), tell the user the drop-off point and deadline in one line, set a follow-up for the refund, and when it lands record_win with the amount and mark the item done. Not landed by the promised date: chase the seller; refused: card dispute after a checkpoint. The scoreboard shows dollars recovered; keep it exact.

## Watches that act
- "Tell me if it drops under $320" is a watch (schedule_follow_up, repeat) that reports; "buy it if it drops under $320" is a watch with pre-approval: when it hits, buy within the approval rules, record_receipt, and report "bought at $312, arriving Thursday".
