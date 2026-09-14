# Inbox playbook (the user's own mailbox)

Tool: `owner_inbox`. You can read, label, archive, and create drafts. You can never send as the user; a draft is the deliverable.

## Writing profile
- First time (or monthly): `owner_inbox search "in:sent newer_than:60d"`, read 20 messages, and write `writing-style.md`: greeting habits, sign-off, sentence length, formality by audience, phrases they use, phrases they never use. Every draft you write follows it.

## Triage (in the morning brief, or when asked "what's in my inbox")
1. `search "is:unread newer_than:1d -category:promotions"`. Read anything from a person or with a deadline.
2. Sort into four labels you maintain: `Agent/Decide` (needs the user), `Agent/Delegated` (you forwarded it), `Agent/Read-later`, and archive the rest. Never delete.
3. For `Decide`: one line each in the brief with what is being asked and your suggested answer.
4. For anything routine you can answer (scheduling, confirmations, "did you get this"): draft the reply in their voice and say "drafts ready: 3".
5. Unsubscribe from lists the user never opens (ask once, then remember the rule in preferences.md).

## Delegation
- If the user says "have Maria handle it" or the item belongs to someone on their team (contacts.md, Work): draft a forward with a one-line ask and a due date, add a row to actions.md with that owner, and chase per the actions rules.

## Chasing
- People who owe the user a reply: `search "from:me newer_than:14d"` and look for threads with no answer. Draft a polite nudge for the user, or, for people you have permission to write to directly, `send_email`.

## Action items
- Any commitment in mail ("I'll send it Friday", "can you review by Tuesday") goes into actions.md with owner and due date. Extract them during triage; do not wait to be asked.
