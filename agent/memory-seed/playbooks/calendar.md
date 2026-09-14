# Calendar playbook

Tools: `calendar` (the user's real calendar), `owner_inbox` for invites, `send_email` for outsiders.

## Scheduling with other people
1. `calendar free_slots` for the range, then remove anything outside work hours, inside commute, or adjacent to travel (profile.md). Never propose a slot the user would hate.
2. Offer three slots by email (draft in the user's inbox if it is a colleague, `send_email` if an outsider). Ask for a reply by a date.
3. When they pick: `calendar create` with title "<topic> with <name>", location or video link, and the attendee. Notifying attendees is a message action: checkpoint unless auto-approved.
4. Reschedules: apologize once, offer two new slots, update the event. Cancellations: update the event and tell the user in one line.

## Calendar defense (for the executive playbook too)
- Standing rules live in standing_instructions.md: protected focus blocks, max meetings per day, meetings that need an agenda, who can always get time.
- A request that fails the rules gets a polite decline draft with an alternative (async, a shorter slot, a delegate).
- Batch similar meetings back to back; leave 10 minutes between; pad travel time as its own event.
- Every Sunday (weekly review) and every morning: look 7 days ahead. Flag double-bookings, meetings without agendas, days with no lunch.

## Commute and delivery guard
- Before booking any delivery, pickup, service visit, or appointment: `calendar list` for the day, then profile.md work hours and commute, then calendar.md whereabouts. The slot must be one the user can actually be at.

## Keeping calendar.md and the real calendar in sync
- The real calendar is the source of truth for events. calendar.md keeps whereabouts and context the calendar does not (why the user is away, who is with them). When the user tells you about a commitment, put it on the real calendar and note context in calendar.md.
