import type { ToolDef } from "../llm.js";

/**
 * Tool definitions the model sees. Frozen order, so the request prefix (tools, then system prompt) caches.
 * Every schema is strict: the API guarantees the arguments validate, so the handlers never guess.
 */
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const s = (description: string) => ({ type: "string", description });
const n = (description: string) => ({ type: "number", description });
const b = (description: string) => ({ type: "boolean", description });

const tool = (name: string, description: string, input_schema: ReturnType<typeof obj>): ToolDef => ({ name, description, input_schema, strict: true } as ToolDef);

export const TOOLS: ToolDef[] = [
  // ---- browser
  tool("browser_navigate", "Open a URL in this task's tab and return the page snapshot (accessibility tree with refs).", obj({ url: s("Full URL, or a domain.") }, ["url"])),
  tool("browser_snapshot", "Snapshot of the current page: every element you can act on, with refs. Use after a page changed on its own or when refs look stale.", obj({ interactive_only: b("Only controls, headings and short text; smaller on long pages.") })),
  tool("browser_find", "Find elements or text on the current page by a word or phrase; returns matching lines with refs. Cheaper than a full snapshot on long pages.", obj({ text: s("Text to look for (case-insensitive).") }, ["text"])),
  tool("browser_click", "Click an element by ref, or by x,y from a screenshot.", obj({ ref: s("Element ref from the snapshot, e.g. e12"), x: n("Pixel x (with y) when clicking from a screenshot"), y: n("Pixel y"), double: b("Double-click"), button: s("left (default), right or middle") })),
  tool("browser_type", "Type text into a field (clears it first unless clear=false). submit=true presses Enter after typing.", obj({ ref: s("Field ref"), text: s("Text to type"), submit: b("Press Enter afterwards"), clear: b("Clear the field first (default true)"), slowly: b("Type key by key, for fields with autocomplete suggestions") }, ["ref", "text"])),
  tool("browser_fill", "Fill several form fields in one call: text boxes, selects (by option label), checkboxes and radios (true/false). Returns per-field status and the page changes.", obj({ fields: { type: "array", description: "Fields to fill", items: obj({ ref: s("Field ref"), value: { type: ["string", "boolean", "number"], description: "Value: text, option label, or true/false" } }, ["ref", "value"]) } }, ["fields"])),
  tool("browser_select", "Choose an option in a select box by its label or value.", obj({ ref: s("Select ref"), value: s("Option label or value") }, ["ref", "value"])),
  tool("browser_press", "Press a key (Enter, Tab, Escape, ArrowDown, PageDown, Control+a ...), optionally on a specific element.", obj({ key: s("Key name"), ref: s("Element to focus first") }, ["key"])),
  tool("browser_hover", "Hover over an element (opens hover menus).", obj({ ref: s("Element ref") }, ["ref"])),
  tool("browser_scroll", "Scroll the page (down, up, top, bottom, left, right) or bring an element into view.", obj({ direction: s("down (default), up, top, bottom, left, right"), amount: n("Pixels (default 700)"), ref: s("Scroll this element into view instead") })),
  tool("browser_wait", "Wait until text appears (or disappears) or the URL contains something, up to `seconds`. With no condition, waits `seconds` for the page to settle. Use for slow pages and live-chat replies.", obj({ text: s("Wait for this text to appear"), text_gone: s("Wait for this text to disappear"), url_contains: s("Wait for the URL to contain this"), seconds: n("Timeout in seconds (default 10, max 180)") })),
  tool("browser_read", "The page's visible text, for reading articles, orders, statements, chat transcripts. Paginate with offset.", obj({ mode: s("'text' (whole page, default) or 'main' (main content only)"), max_chars: n("Characters to return (default 20000)"), offset: n("Start position for long pages") })),
  tool("browser_screenshot", "A screenshot of the viewport (JPEG). Use when layout matters or the snapshot is ambiguous; then browser_click with x,y works.", obj({ full_page: b("Capture the full page instead of the viewport") })),
  tool("browser_back", "Go back one page.", obj({})),
  tool("browser_tabs", "List, switch, open or close this task's tabs.", obj({ action: s("list (default), switch, new, close"), index: n("Tab index for switch/close"), url: s("URL for new") })),
  tool("browser_upload", "Attach a company file to a file input or an upload button.", obj({ ref: s("The file input or upload button ref"), file_id: s("Id of the file (from file_list or an earlier result)") }, ["ref", "file_id"])),
  tool("browser_pdf", "Save the current page as a PDF file (a confirmation page, a receipt, a statement).", obj({ name: s("File name without extension") })),
  tool("browser_fill_login", "Fill a site's sign-in form from the company's vault. Point at the username and/or password fields; the secret is typed by the host and never shown to you. code_ref for an authenticator code when the vault has the seed.", obj({ site: s("The site's domain or URL"), username_ref: s("Ref of the username/email field"), password_ref: s("Ref of the password field"), code_ref: s("Ref of the authenticator-code field"), username_hint: s("Which account, when the vault has several for the site"), submit: b("Press Enter after filling") }, ["site"])),
  tool("browser_close", "Close this task's tabs when you no longer need the browser.", obj({})),

  // ---- web
  tool("web_search", "Search the web. Returns titles, URLs and snippets.", obj({ query: s("Search query"), count: n("Results (default 8)") }, ["query"])),
  tool("web_fetch", "Fetch a URL without the browser and return its text (fast for articles, docs, APIs). Use the browser for anything interactive or behind a login.", obj({ url: s("URL"), max_chars: n("Characters to return (default 15000)") }, ["url"])),

  // ---- email
  tool("email_send", "Send an email as the company. Outsiders go through the approval policy: the result says sent or waiting for approval. Body is markdown.", obj({ to: s("Recipient(s), comma-separated"), subject: s("Subject"), body: s("Body in markdown"), cc: s("CC, comma-separated"), reply_to_message_id: s("Message id (from email_read) to reply in thread"), attachments: { type: "array", description: "File ids to attach", items: { type: "string" } }, kind: s("What this message does: reply, request, complaint, negotiation, notice, internal") }, ["to", "subject", "body"])),
  tool("email_search", "Search the company's connected mailbox (subject, sender, body).", obj({ query: s("Words to look for; empty for the latest"), limit: n("Max results (default 10)"), from: s("Only from this sender"), days: n("Only the last N days") })),
  tool("email_read", "Read one email in full by id (from email_search), including attachment file ids.", obj({ id: s("Email id") }, ["id"])),

  // ---- memory
  tool("memory_search", "Search the company's long-term memory: facts, site notes, contacts, procedures, past task history.", obj({ query: s("Words to search for"), kind: s("fact, site, contact, procedure, history (optional)") }, ["query"])),
  tool("memory_save", "Save or replace a memory note. kind: fact (durable facts and rules), site (how a site works, keyed by domain), contact (a person or company), procedure (how we do X), history (only the host writes these).", obj({ kind: s("fact, site, contact, procedure"), key: s("Short unique key, e.g. 'amazon.com', 'billing contact at acme'"), content: s("The note (markdown, under 40 lines)") }, ["kind", "key", "content"])),

  // ---- files
  tool("file_create", "Create a text, markdown, CSV or HTML file from content.", obj({ name: s("File name with extension"), content: s("File content") }, ["name", "content"])),
  tool("pdf_create", "Render markdown (headings, lists, tables) into a PDF file: letters, invoices, summaries, completed forms.", obj({ name: s("File name without extension"), markdown: s("Document content in markdown"), title: s("Document title shown at the top") }, ["name", "markdown"])),
  tool("file_read", "Read a file's text (PDFs extracted).", obj({ file_id: s("File id"), max_chars: n("Characters to return (default 40000)") }, ["file_id"])),
  tool("file_list", "List the company's recent files with ids.", obj({ limit: n("Max (default 30)") })),

  // ---- task control
  tool("report_progress", "One line for the user on where you are. Use during long tasks; not a substitute for finishing.", obj({ text: s("One or two sentences") }, ["text"])),
  tool("ask_user", "Ask the user something only they know. Pauses this task until they answer. Batch every question into one call and state the default you will assume.", obj({ question: s("The question(s), with defaults"), options: { type: "array", description: "Optional short answers to offer as buttons", items: { type: "string" } } }, ["question"])),
  tool("request_approval", "Ask for approval before a consequential step: a purchase, a payment, a message to an outsider, a cancellation, an agreement, an account change. Auto-approved when the policy allows; otherwise the task pauses until the user decides.", obj({ kind: s("purchase, payment, email, cancel, agreement, account, other"), action: s("What you are about to do, in one sentence"), details: s("The facts the user needs: amount, counterparty, terms, what happens next"), amount_usd: n("Money involved, in USD, if any") }, ["kind", "action", "details"])),
  tool("wait_until", "Pause this task and resume later (a reply expected, a delivery, a refund window). Say what to check when it resumes.", obj({ when: s("ISO date-time, or a duration like '30m', '2h', '3d'"), reason: s("What you are waiting for and what to do on resume") }, ["when", "reason"])),
  tool("schedule_task", "Create a separate task for later, or a recurring one. Use for follow-ups that should run even if this task ends, and for standing routines.", obj({ title: s("Short title"), instruction: s("Complete instructions for that task, with every identifier it needs"), run_at: s("ISO date-time or duration ('2d') for a one-off"), cron: s("Cron expression for a recurring task (5 fields, business-local time)") }, ["title", "instruction"])),
  tool("create_task", "Start a sibling task now, in parallel, for independent work (e.g. 'compare prices at three vendors' -> three tasks). Results are reported to the user separately.", obj({ title: s("Short title"), instruction: s("Complete instructions") }, ["title", "instruction"])),
  tool("finish_task", "End the task with the result for the user. outcome: done (finished with evidence), blocked (needs something only the user can provide; say exactly what), failed (tried the routes and it cannot be done; say why).", obj({ outcome: s("done, blocked or failed"), result: s("The report: outcome first, then figures and references, then assumptions and what remains") }, ["outcome", "result"])),
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
