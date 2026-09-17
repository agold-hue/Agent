# Thirty changes that would move the needle

Each item names the mechanism in this codebase it changes and why the gain is large. They are grouped
by what they buy: faster replies, more tasks completed correctly, and lower cost without giving any
capability back. Where one change helps two goals it is listed once, under the goal it helps most.
Things the code already does (adaptive tiers from `task_outcomes`, figures verified against what the
task read, recorded site paths, the lookup fast path, parallel read-only tool calls, snapshot diffs,
idle browser release) are not repeated here.

## Faster replies

1. **Run the first turn inside the send request.** Today a message is stored, a worker is kicked over
   public HTTPS (`kick`, up to `KICK_WAIT_MS`), the worker starts cold (the catalog, the tenant, the
   memory files, the context block), and the page notices the reply on its poll. For a quick question
   that is most of the latency. Stream the first completion from `chat/send` itself and hand off to
   the worker only when the model calls a tool that needs one; a greeting then answers in one round
   trip.
2. **Push updates instead of polling.** `chat/history` is polled every second or two and rebuilds the
   whole 30-day timeline whenever the fingerprint changes; the streamed draft is throttled to 700 ms
   on the way in and a poll interval on the way out. Postgres `LISTEN/NOTIFY` behind a per-user SSE
   endpoint that sends deltas cuts the perceived lag of every token, every `tell_user` line and every
   card to near zero.
3. **Answer the send request before the kick lands.** `kick` waits `KICK_WAIT_MS` before the send
   handler responds. `@vercel/functions` is already a dependency: `waitUntil(kick())` returns the
   response at once and still delivers the kick; the page's own stall re-kick covers a lost one.
4. **Host-written status replies.** A pure status ping ("status", "any luck?", "you there?") needs no
   model at all: `sessionProgress` already knows the task, the minutes, the last steps and what it is
   waiting for. Post that as the side reply directly and reserve the chat model for questions that
   need words; the answer is instant and free.
5. **A lean prompt for quick replies.** Every quick question and side reply carries the full shared
   system prompt (browser, sign-in and project guidance) plus the context block. A 1,500-token quick
   prompt (voice, the user's facts, memory and calendar tools) cuts time to first token on Gemini by
   seconds and the cost of every greeting by most of it.
6. **Open the browser while the model thinks.** `browser_open` and the Browserbase connect take
   several seconds and always come first on a task-tier request. When the request names a site (the
   `sitesIn` match already exists) and the site note has a recorded path, start the tab and replay the
   path in parallel with the first completion, and hand the model the page it would have reached.
7. **Keep the worker warm after a reply.** A run ends the moment the reply is written, and the next
   message ("and the other one?") pays the kick and the cold start again. Let the worker wait a short
   while for the next message on the same thread (a long poll on the session) with the context already
   in memory, and start the next turn the instant it lands.
8. **Return pages on readiness, not on a timer.** `PAGE_SETTLE_MS` and the network-idle wait are paid
   on every navigation, ten or twenty times per task. Return as soon as the page has interactive
   controls or the element the recorded path names, and fall back to the timer only when nothing
   appears.
9. **Keep the prefix cache warm.** The system prompt is now one shared cache entry; the first call of
   a task still pays for and waits on the context block. A zero-output completion with the prompt and
   the user's block when the app opens (and before the morning brief) means the first real call reads
   both from cache, which is also the faster path.
10. **Interrupt a wait when a steer arrives.** A message sent mid-task is picked up only at the top of
    the next turn, after the current tool finishes; a `browser_wait_for` or `browser_watch` can hold
    that for half a minute. Abort the pending wait when a user message lands on the session, so "no,
    the Amex" is applied at once instead of after the page times out.

## Better completions

1. **Pre-flight before the first browser step.** Many failures are discovered twenty steps in: no
   login saved for the site, Google not connected for the read the task needs, an address or card
   missing from `facts.md`. Check those from the request before the first tool call and ask the one
   question up front, with the fix card, instead of after the budget is spent.
2. **Two strikes, then the host switches routes.** Rule 3 asks the model to try another route before
   giving up; a stuck model rarely does. When the same page state recurs after two attempts, the host
   injects the alternatives itself (the direct URLs from the playbook and the site note, the site's
   search, `web_search` for the right page) as a note, before the loop guard and escalation.
3. **Feed the post-mortems back into the task.** `history/failures.md` records why tasks failed and
   the one change that would have helped, but only the morning review reads it. Inline the last
   failure for the same site or class into the task's notes ("last time: the code screen expired
   because of a reload"), so the same mistake is not made twice.
4. **A second reading before money moves.** Before a payment or purchase checkpoint, a cheap model
   re-reads the page about to be confirmed (the screenshot is already taken) and checks amount, payee,
   account and card against the request and `facts.md`. A mismatch blocks the checkpoint with the
   specific discrepancy rather than asking the user to spot it.
5. **Keep a pinned task state.** Compaction trims old tool output and can drop the plan with it. The
   host maintains a short block (goal, done so far, next step, open blockers) refreshed every few turns
   and placed just before the newest message; long tasks keep their thread after any compaction.
6. **A planning turn before escalation.** When the loop guard trips or half the step budget is spent,
   one no-tools turn asks what has been learned and which different route comes next. Most stuck tasks
   are stuck on a route, not on model strength; this recovers many of them without the expensive tier.
7. **Form state in snapshots.** Snapshots list controls and labels; they do not say which radio is
   selected, which box is checked, what a field already holds, or that a modal is covering the page.
   Adding that state cuts wrong clicks and "typed but nothing changed" loops on checkouts and portals.
8. **Automatic screenshot on a stalled page.** When two snapshots in a row are identical after actions,
   the page is likely a canvas, an overlay or a modal the text layer cannot see. Take one screenshot
   then (vision models only) instead of waiting for the model to think of it.
9. **A hand-off note on escalation.** `escalate_model` continues on the stronger model with the whole
   messy context. Have the departing model write a ten-line hand-off (goal, what worked, what failed,
   where the page is now) and start the stronger model from that plus the last few turns; it does
   better with a clean brief than with forty turns of a weaker model's flailing.
10. **A task replay harness.** The search golden set and the weekly grading sample cover lookups and a
    sample of replies. Record every session's tool inputs and outputs and replay the prompts offline
    against a candidate model or prompt, scoring against the recorded outcome, so every routing and
    prompt change can be measured before it ships instead of judged from transcripts.

## Cheaper, with nothing given back

1. **Adaptive tiers that forgive and remember sites.** The step-down needs a clean record: one failure
   in the class in sixty days blocks the cheaper tier for everyone in that class. Score by site as well
   as class, let a class recover after a run of successes on the pricier tier, and keep a site that
   beat the cheaper tier pinned up for thirty days; the cheaper tier then takes far more of the work.
2. **Plan on the judgment model, execute on the task model.** A refund or a negotiation needs judgment
   for the plan and the messages to the counterparty, not for clicking through an orders page. Let the
   hard tier write the plan and the wording, and hand the browser steps to the task tier, escalating
   back only at decision points; most of a hard task's tokens are browser steps.
3. **Budget by value at stake.** The caps are by class (`LOOKUP_BUDGET_USD`, `TASK_BUDGET_USD`). A
   task whose request names an amount (a $12 refund, a $9 subscription) should not spend a dollar of
   judgment-model time on it; scale the budget and the tier ceiling to the money involved and tell the
   user when the ladder stops paying.
4. **No reasoning tokens on mechanical steps.** The client sends no reasoning settings, so a thinking
   model thinks at its default on every "click [12]" and every greeting, billed as output at the top
   rate. Set reasoning off for the chat tier and low for browser steps, leaving the default for the
   judgment tier and for planning turns.
5. **Tools per request class.** Quick questions already get a smaller tool set. Extend the classes: a
   calendar or memory task gets no browser tools, a browser task gets no Google tools when Google is
   not connected, a proactive review gets no sign-in tools. Thousands of tokens of tool definitions
   ride on every call today.
6. **Cap output per tier.** `max_tokens` is 4,000 everywhere except after a tool result; chat replies
   are one to four lines. A cap of a few hundred tokens on the chat tier stops the occasional runaway
   completion, and on the judgment tier a runaway is the most expensive kind of token there is.
7. **Merge the morning's proactive sessions.** The morning review, the inbox sweep and the mail triage
   run as separate sessions, each paying for the context block. One morning session with three phases
   shares the prefix (and the cache) and reports once.
8. **Compact with hysteresis so the cache holds.** `compacted` stubs every tool result older than the
   newest six on every call, so the boundary moves one message each turn and everything after it is
   re-read at full price on Claude. Stub in batches (only once twelve are whole, back down to six) and
   the prefix stays byte-identical for six turns at a time, which is what the cache breakpoints need.
9. **A short hand-off instead of a re-read on escalation.** The escalation above is also a cost item:
   the stronger model re-reads the whole context at full price (a new model, no cache). A ten-line
   hand-off plus the last turns costs a fraction and is what the stronger model wants anyway.
10. **Price the choice of provider for open-weight models only.** Provider order comes from measured
    first-token times for every model. For Claude and Gemini the providers are the same price, so
    nothing is lost; for DeepSeek and the open models the price spread across providers is large and
    the fastest is often the dearest. Sort by price for those ids and by speed for the rest.
