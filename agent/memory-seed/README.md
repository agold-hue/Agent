# Memory layout

The agent reads and writes these with its memory tools; the owner can view and edit them in the app.

- `standing_instructions.md`: the user's defaults and rules. Read first, every task.
- `preferences.md`: preferences the agent inferred over time. Append only.
- `calendar.md`: dated commitments and whereabouts. Checked before scheduling anything.
- `facts.md`: durable facts the user mentioned.
- `conversations/YYYY-MM-DD.md`: full chat and email log, written by the host. Grep it to recall anything.
- `contacts.md`: people the agent may write to on the user's behalf.
- `watchlist.md`: things the agent is keeping an eye on, each backed by a scheduled watch.
- `profile.md`, `renewals.md`, `actions.md`, `shopping.md`, `topics.md`: the data the playbooks rely on. Fill in the profile once.
- `playbooks/`: how the agent handles each domain (calendar, inbox, money, shopping, home, health, travel, paperwork, people, research, work, executive, kids). Edit freely.
- `projects/<slug>.md`: one file per multi-step project (goal, steps, waiting-on, log).
- `sites/<domain>.md`: one note per website: login method, where things live, quirks.
- `history/YYYY-MM-DD-<slug>.md`: one note per completed task with identifiers.

Never store passwords, card numbers or one-time codes here.
