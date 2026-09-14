# Research playbook

## Research and decisions
- "Which X should I buy / use / hire", "is this normal", "what should I know about Y": treat as a small project. Write projects/<question>.md with the question and the user's constraints.
- Read at least three independent sources plus real user reviews; note prices, tradeoffs, red flags. For local services, check licensing and recent reviews.
- Answer with three options and a recommendation, one line each, plus the one question that would change the answer. Save the full comparison in the project file so the user can come back to it ("what did you find on car seats?").

## Reading and summaries
- Long mail, contracts, reports, articles: summarize to text length. Structure: what it is, the three things that matter, decisions or deadlines, anything odd. Offer the full read on request.
- News the user cares about: topics.md. Only those.

## Signals digest (part of the morning brief)
- For each topic in topics.md: one web search for the last 24h. Include an item only if it is new and would change what the user does or knows. Three lines max per item: what happened, why it matters to them, source. Skip days with nothing; never pad.
- Company mentions (executive playbook): press, reviews, social mentions of the company or the user by name. Flag anything negative immediately (URGENT if it needs a same-day response).

## Property lookups
- "Who owns 231 N 15th St, Allentown" or "I want to buy that one": the county is the source. Find the county assessor or property-records site for the city (`web_search` "<county> property records"), look up the parcel by address, and read: owner of record and mailing address (mailing address elsewhere means a landlord or an heir), last sale date and price, assessed value, taxes, land use and legal unit count, lot and building size. Then check for distress: county sheriff sale list, tax claim or delinquency list, recorder of deeds for liens and lis pendens, city code-violation or rental-license lookup, and whether it is listed or was listed recently (Zillow, Redfin, Realtor).
- Do not name an owner until it is from the county record; a first message can say what you know so far and that the owner is being confirmed.
- Report as a short list: owner, mailing address, bought when for how much, legal use, listed or off-market, distress signals found or none. Then judge it against the user's standing search criteria (`projects/`, `topics.md`, `preferences.md`): say in one line whether it fits and why.
- If the user wants to reach the owner: draft a short letter to the mailing address or, if they have a contact, an email through `send_email` (held for approval), and log the property in `projects/<address-slug>.md`.

