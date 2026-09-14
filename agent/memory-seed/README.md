# Memory layout

- `standing_instructions.md`: the user's defaults and rules. Read first, every task.
- `preferences.md`: preferences the agent inferred over time. Append only.
- `calendar.md`: dated commitments and whereabouts. Checked before scheduling anything.
- `facts.md`: durable facts the user mentioned.
- `conversations/YYYY-MM-DD.md`: full chat and email log, written by the host. Grep it to recall anything.
- `contacts.md`: people the agent may write to on the user's behalf.
- `projects/<slug>.md`: one file per multi-step project (goal, steps, waiting-on, log).
- `sites/<domain>.md`: one note per website: login method, where things live, quirks.
- `history/YYYY-MM-DD-<slug>.md`: one note per completed task with identifiers.

Never store passwords, card numbers or one-time codes here.
