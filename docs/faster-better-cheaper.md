# Thirty changes that would move the needle

Each item names the mechanism in this codebase it changes and why the gain is large. They are grouped
by what they buy: faster replies, more tasks completed correctly, and lower cost without giving any
capability back. Where one change helps two goals it is listed once, under the goal it helps most.

## Faster replies

1. **Run the first turn inside the send request.** Today a message is stored, a worker is kicked over
   public HTTPS (`kick`, a 1.2 s wait), the worker cold-starts (`warmCatalog`, the tenant, five memory
   files, the prompt), and the page notices the reply on a 1.2 s poll. For a quick question that is
   most of the latency. Stream the first completion from `chat/send` itself and hand off to the worker
   only when the model calls a tool that needs one; a greeting then answers in one round trip.
2. **Push updates instead of polling.** `chat/history` is polled every 1.2 s and rebuilds the whole
   30-day timeline whenever the fingerprint changes; the streamed draft is throttled to 700 ms on the
   way in and 1.2 s on the way out. Postgres `LISTEN/NOTIFY` (or a per-user SSE endpoint) that sends
   deltas cuts the perceived lag of every token, every `tell_user` line and every card to near zero.
3. **Answer the send request before the kick lands.** `kick` waits `KICK_WAIT_MS` before the send
   handler responds. `@vercel/functions` is already a dependency: `waitUntil(kick())` returns the
   response at once and still delivers the kick.
4. **Host-written status replies.** A pure status ping ("status", "any luck?", "you there?") needs no
   model at all: `sessionProgress` already knows the task, the minutes, the last steps and what it is
   waiting for. Post that as the side reply directly and reserve the chat model for questions that
   need words; the answer is instant and free.
5. **A lean prompt for quick replies.** Every quick question carries the full system prompt (about
   ten thousand tokens of browser, sign-in and project guidance) plus the known facts. A 1,500-token
   quick prompt (voice, the user's facts, memory and calendar tools) cuts time to first token on Gemini
   by seconds and the cost of every greeting by most of it.
6. **Open the browser while the model thinks.** `browser_open` and the Browserbase connect take
   several seconds and always come first on a task-tier request. When the request names a site (the
   `sitesIn` match already exists), start the tab and navigate to the site's fast path from
   `sites/<domain>.md` in parallel with the first completion, and hand the model a ready snapshot.
7. **Run independent tool calls concurrently.** The loop executes a turn's tool calls one after
   another. Memory reads, `list_items`, `calendar` and `web_search` do not depend on each other; running
   them with `Promise.all` turns a three-lookup quick question into one wait.
8. **Return pages on readiness, not on a timer.** `PAGE_SETTLE_MS` (8 s) and the network-idle wait are
   paid on every navigation, ten or twenty times per task. Return as soon as the page has interactive
   controls or the element the fast path names, and fall back to the timer only when nothing appears.
9. **Keep the prefix cache warm.** On Claude the first call of a task pays full price for the prompt
   and waits for it; a zero-output completion with the system prompt when the app opens (and before
   the morning brief) means the first real call reads it from cache, which is also the faster path.
10. **Show the acknowledgement locally.** The "on it" line is returned in the send response and then
    fetched again through `loadHistory`; rendering it from the response and letting the poll reconcile
    removes a request from the critical path of every task-tier message.

## Better completions

1. **Verify the report against the evidence before it is sent.** Rule 5 says done means evidence, but
   nothing checks it. Before a task-tier or hard-tier reply, a cheap no-tools call compares each figure
   and confirmation number in the reply with the tool results in the context; a number that appears
   nowhere sends the model back with a nudge instead of reaching the user.
2. **Replay the site's fast path before the model touches the page.** `sites/<domain>.md` is prose the
   model reads. Store the fast path as data (URL, login domain, the text to wait for, where the figure
   is) and have the host execute it deterministically at the start of a repeat task; the model starts
   from the balance page, not the home page, and the twenty-step visit becomes five.
3. **Feed the post-mortems back into the task.** `history/failures.md` records why tasks failed and
   the one change that would have helped, but only the morning review reads it. Inline the last
   failure for the same site or domain into the task's notes ("last time: the code screen expired
   because of a reload"), so the same mistake is not made twice.
4. **A second reading before money moves.** Before a payment or purchase checkpoint, a cheap model
   re-reads the current page and checks amount, payee, account and card against the request and
   `facts.md` (the auditor rule). A mismatch blocks the checkpoint with the specific discrepancy.
5. **Keep a pinned task state.** Compaction trims old tool output and can drop the plan with it. The
   host maintains a short block (goal, done so far, next step, open blockers) refreshed every few turns
   and placed just before the newest message; long tasks keep their thread after any compaction.
6. **A planning turn before escalation.** When the loop guard trips or half the step budget is spent,
   one no-tools turn asks what has been learned and which different route comes next. Most stuck tasks
   are stuck on a route, not on model strength; this recovers many of them without the expensive tier.
7. **Richer page snapshots.** The numbered-element snapshot loses form state. An accessibility-tree
   snapshot with roles, labels, current values, checked and selected states, and modal detection cuts
   wrong clicks and "typed but nothing changed" loops on checkouts and utility portals.
8. **Automatic screenshot on a stalled page.** When two snapshots in a row are identical after actions,
   the page is likely a canvas, an overlay or a modal the text layer cannot see. Take one screenshot
   then (vision models only) instead of waiting for the model to think of it.
9. **A hand-off note on escalation.** `escalate_model` continues on the stronger model with the whole
   messy context. Have the departing model write a ten-line hand-off (goal, what worked, what failed,
   where the page is now) and start the stronger model from that plus the last few turns; it does
   better with a clean brief than with forty turns of a weaker model's flailing.
10. **A replay harness.** Record every session's tool inputs and outputs and replay the prompts offline
    against a candidate model or prompt, scoring the reply against the recorded outcome. Every routing
    and prompt change above can then be measured before it ships instead of judged from anecdotes.

## Cheaper, with nothing given back

1. **Learn which tier each class of work needs.** Record the outcome of every task (finished with
   evidence, stopped, escalated, looped) by tier, request class and site. Where the cheaper tier's
   success rate matches the pricier one, route there by default; where it does not, keep the pricier
   tier. The router then picks the cheapest capable model from data rather than from a regex.
2. **Plan on the judgment model, execute on the task model.** A refund or a negotiation needs judgment
   for the plan and the messages to the counterparty, not for clicking through an orders page. Let the
   hard tier write the plan and the wording, and hand the browser steps to the task tier, escalating
   back only at decision points; most of a hard task's tokens are browser steps.
3. **Budget by value at stake.** `SESSION_BUDGET_USD` is flat. A task whose request names an amount
   (a $12 refund, a $9 subscription) should not spend $3 of judgment-model time on it; scale the budget
   and the tier ceiling to the money involved and tell the user when the ladder stops paying.
4. **Return page diffs, not pages.** After a click or a scroll, most of the snapshot is what the model
   already saw. Return only the changed region (and "unchanged since step N" for an identical page),
   and the per-turn input drops sharply on every browser task; the model also loses less attention to
   repetition.
5. **Tools per request class.** Quick questions already get a smaller tool set. Extend the classes: a
   calendar or memory task gets no browser tools, a browser task gets no Google tools when Google is
   not connected, a proactive review gets no sign-in tools. About four thousand tokens of tool
   definitions ride on every call today.
6. **Cap output per tier.** `max_tokens` is 4,000 everywhere; chat replies are one to four lines. A cap
   of a few hundred tokens on the chat tier and a thousand on task steps stops the occasional runaway
   completion, which on the judgment model is the single most expensive kind of token.
7. **Merge the morning's proactive sessions.** The morning review, the inbox sweep and the mail triage
   run as separate sessions, each paying for the full prompt and the known facts. One morning session
   with three phases shares the prefix (and the cache) and reports once.
8. **Release the browser when nothing will use it.** Hosted browser minutes are money too. Close the
   customer's browser when no session has used it for a few minutes and no timer is due soon, and keep
   the profile (the cookies survive); today it lingers while tasks are idle.
9. **A short hand-off instead of a re-read on escalation.** The escalation above is also a cost item:
   the stronger model re-reads the whole context at full price (a new model, no cache). A ten-line
   hand-off plus the last turns costs a fraction and is what the stronger model wants anyway.
10. **Price the choice of provider for open-weight models only.** `LLM_SORT` favours throughput for
    every model. For Claude and Gemini the providers are the same price, so nothing is lost; for
    DeepSeek and the open models the price spread across providers is large and the fastest is often
    the dearest. Sort by price for those ids and by throughput for the rest.
