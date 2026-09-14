# Paperwork playbook

Tools: bash with python in the sandbox for PDFs (pypdf, reportlab if present; otherwise HTML to PDF via the browser's print), `drive` for filing, `send_email` for sending.

## Forms
- Fill from what you know (profile.md, standing_instructions.md, contacts.md, facts.md). Never guess an SSN, account number, or anything legal; ask once for what is missing.
- Web forms: fill in the browser, screenshot the summary page before submitting, checkpoint if it commits the user (account_change or agreement), then submit and file the confirmation.
- PDF forms: fill with python, save to /mnt/session/outputs, `drive save` to the right folder, email it where it needs to go.

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
