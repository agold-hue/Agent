# Home playbook

Data: profile.md (Home, Family), contacts.md (service providers), renewals.md (warranties, service dates), calendar.

## Home services
- Recurring maintenance (HVAC service, gutters, pest, filters, car service) lives in renewals.md with a watch. When due: book with the usual provider from contacts.md at a slot the user is home; tell the user the date.
- New job (a repair, a project): get three quotes by email or web form with the same description and photos, compare price, availability, reviews, and licensing, recommend one, and checkpoint before booking (agreement). Keep the quotes in the project file and Drive/Home.
- Warranties and manuals: file to Drive/Home/<appliance> and note the warranty end in renewals.md.

## Deliveries and packages
- Every tracking number from forwarded mail becomes a `track_item` (kind package, what it is in the title, carrier and tracking number in details, expected day as due) and a watch on the delivery day. "Where's my package": `list_items` kind package, check the carrier page only for items with no expected day or past due. Delivered: mark the item done.
- Every tracking number from forwarded mail gets a watch on the delivery day. Deliveries must not land while the user is away (calendar guard); hold or redirect with the carrier if they would.
- Late by more than a day: chase the carrier, then the seller (escalation ladder). Arrived damaged: photos from the user, then the refund ladder.

## Food and reservations
- Restaurants: the user's usual places and dietary notes in preferences.md. Book for the date they mention, at their usual time, party size from the message; put it on the calendar and `track_item` (kind reservation, place, time, party size, confirmation); `record_receipt`; cancel if a trip appears on that date.
- Appointments (doctor, dentist, barber, car service, contractor): book online through the provider's site or portal when it has one, otherwise email the provider from contacts.md with two or three slots that are free on the calendar. Once set: calendar, `track_item` (kind appointment, location, who), a reminder watch the evening before.
- Reminders ("remind me to call mom Sunday"): `track_item` (kind reminder, due at the time) plus a `schedule_follow_up` at that time whose note is the reminder text; on the follow-up, send the one-line reminder and mark the item done.
- Grocery orders per the shopping playbook. Meal planning around the calendar when asked: late nights get easy dinners, travel days get nothing.

## Household and family logistics
- Family members in FAMILY_EMAILS can ask you for things by email; reply to them. Anything that spends the owner's money or commits the owner still needs the owner's yes.
- Sitter, cleaner, plumber, vet: book from contacts.md; confirm the day before; text the relevant adult.
- A shared list (shopping.md, actions.md) is the single source; when something touches the other adult's day, say so in the brief or, if same-day, text.
