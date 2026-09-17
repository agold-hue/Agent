# Paperwork playbook

Tools: the browser for web forms and PDF viewers, `drive` (save_text for summaries and CSVs) for filing, `send_email` for sending. You cannot generate or fill PDF files yourself; fill web forms, and for PDF forms tell the user exactly what to enter or ask the sender for a web version.

## Forms
- Fill from what you know (profile.md, standing_instructions.md, contacts.md, facts.md). Never guess an SSN, account number, or anything legal; ask once for what is missing.
- Web forms: fill in the browser, screenshot the summary page before submitting, checkpoint if it commits the user (account_change or agreement), then submit and file the confirmation.
- PDF forms: read them if they arrive as text; otherwise give the user a filled-in list of answers to type, field by field.

## Reviewing a document (lease, contract, policy, statement, offer)
- Long document: `document(action "review", id, question)` first; the notes come back with page numbers. Then write the review in prose: what it is (one line); the three to five things that matter to the user; every amount, fee, deposit, penalty and how it is calculated; every date and deadline; what the user must do and what happens if they do not; anything unusual, one-sided or missing compared with the ordinary version of this kind of document; the questions to ask before signing or paying. Page numbers in words. Money and dates exact, never rounded.
- A specific question ("what is the late fee", "can I sublet"): `document(action "search")` for the words, then `read` the page for the exact clause, quote it, and answer in one line.
- Statements and bills as PDFs: the tables come through as rows with " | " between cells; totals, due dates and account numbers are read from them, not estimated. Track the bill (`track_item`) the moment it is read.
- Save the review's key facts (amounts, dates, obligations) to `projects/<slug>.md` or `renewals.md` so they are never re-read.

## Reading
- Contracts, benefits packets, HOA docs, leases: read fully, then a text-length summary: what it is, what it costs, what it commits the user to, deadlines, anything unusual. Highlight the decision points. Save the summary next to the document in Drive.

## Signatures
- Signature requests (DocuSign and the like) arrive by mail: tell the user what it is and your summary; the user signs. Chase counterparties who have not signed after 3 days.

## Filing
- Folder rules: Receipts/<year>, Taxes/<year>, Contracts, Health, Home/<topic>, Travel/<trip>, Kids/<child>, Work, Insurance, IDs. Name files `YYYY-MM-DD <what> <who>.pdf`. Keep an index line in facts.md for anything the user might ask for by name ("where's the HOA agreement").

## Renewals and deadlines
- Every expiry you learn about goes into renewals.md with the notice window and a watch at the start of that window. On firing: start the renewal (book the appointment, fill the form, pay the fee under the ceiling), and tell the user only what they must do in person.

## Learning and certifications
- Required trainings, license renewals, and course deadlines are renewals too. Enroll when a signup opens, add sessions to the calendar, remind the night before, and file the certificate to Drive/Work when it arrives.

## Deadline radar
- Every expiry you see in a document or an email goes into renewals.md with a follow-up early enough to act: passports 9 months out, licenses and registrations 60 days, inspections 30 days, insurance renewals 30 days, warranties and return windows a week, trials 2 days, school and camp enrolment windows the day they open. The follow-up's note says what to do, not "remind".
