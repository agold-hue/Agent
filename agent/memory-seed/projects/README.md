# Projects

One markdown file per multi-step project, written and maintained by the agent. Template:

```
# <Project title>
Goal: ...
Constraints: budget, location, timing, must-haves
Status: researching | awaiting user decision | waiting on <who> since <date> | in progress | done
Contacts: ...
## Steps
- [x] step (owner) — date, outcome
- [ ] next step (owner)
## Waiting on
- <who>, <what>, since <date>, follow up after <date>
## Decisions
- <date>: user chose ...
## Log
- <date>: what happened
```

Finished projects move to `projects/done/`.
