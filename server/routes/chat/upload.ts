import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { currentChatSession, startChatSession } from "../../../lib/chat.js";
import { ingestFile } from "../../../lib/docstore.js";
import { loadModelHistory } from "../../../lib/model-history.js";
import { chatSessionExhausted, kick } from "../../../lib/runtime.js";
import { atLeastModel, visionTier } from "../../../lib/router.js";
import { appendToolResult, appendUserMessage, updateSession, type SessionRow } from "../../../lib/sessions.js";
import { stampMessage } from "../../../lib/transcript.js";
import { sttConfigured, transcribe } from "../../../lib/stt.js";

/**
 * An attachment (or voice note) while the agent is waiting on the user: it IS the answer (a screenshot
 * of the code that was texted, the photo support asked for). The pending call is resolved with a note
 * and the attachment follows as the next message, so the conversation stays well-formed: a tool call
 * is always followed by its result, never by a user message.
 */
async function answerPendingWith(session: SessionRow, what: string): Promise<void> {
  if (!session.pending_event_id) return;
  const text =
    session.pending_kind === "checkpoint" || session.pending_kind === "send_email"
      ? `NOT APPROVED yet: the user sent ${what} instead of a yes or no; it follows as the next message. Do not perform the action; look at what they sent and respond.`
      : `The user answered with ${what}; it follows as the next message.`;
  await appendToolResult(session, session.pending_event_id, text);
}

/**
 * POST { filename, mimeType, data (base64), voice? }. Images go to the model directly (if it can see);
 * text-like files are inlined; audio is transcribed and treated as a spoken message (voice notes);
 * other files are described by name.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const t = await requireTenant(req, res);
  if (!t) return;
  const body = req.body as { filename?: string; mimeType?: string; data?: string; voice?: boolean };
  if (!body?.filename || !body?.data) return res.status(400).json({ error: "filename and data required" });
  const content = Buffer.from(body.data, "base64");
  if (content.length > 4 * 1024 * 1024) return res.status(413).json({ error: "file too large (4 MB max); email it instead" });
  const mime = body.mimeType ?? "application/octet-stream";
  if (mime.startsWith("audio/") || mime.startsWith("video/webm") || body.voice) {
    if (!sttConfigured()) return res.status(501).json({ error: "voice notes are not enabled on this server; use the dictation button instead" });
    let spoken: string;
    try {
      spoken = await transcribe(content, body.filename, mime);
    } catch (e) {
      return res.status(502).json({ error: (e as Error).message });
    }
    if (!spoken) return res.status(422).json({ error: "could not hear anything in that note" });
    let session = await currentChatSession(t);
    if (session && !session.pending_kind && chatSessionExhausted(session)) session = undefined; // roll over to a fresh task
    if (!session) session = await startChatSession(t, `(voice note) ${spoken}`);
    else {
      if (session.pending_kind) await answerPendingWith(session, "a voice note");
      await appendUserMessage(session, stampMessage(t, `(voice note) ${spoken}`, "chat"));
    }
    await kick(session.id);
    return res.status(200).json({ session_id: session.id, text: spoken });
  }
  const isImage = mime.startsWith("image/");
  // PDFs (a bill from the utility's app, a statement, a receipt) and text files are read here, so the
  // model gets the contents rather than a note that it cannot open them.
  const text = isImage ? `(Attached photo: ${body.filename})` : (await ingestFile(t, content, mime, body.filename, "chat")).text;
  const images = isImage ? [{ mimeType: mime, base64: body.data }] : undefined;
  // What to do with it: a document is handled like forwarded mail, a photo is read for what it shows.
  const handle = isImage
    ? "(Read it. If it shows a verification code, enter it now; a bill, receipt, confirmation or tracking number gets tracked and filed per the playbooks; otherwise say in one line what you see and wait for the user's message about it.)"
    : "(Handle it the way you handle forwarded mail: a bill gets a track_item with the amount and due date and goes on renewals.md and the watchlist; a receipt gets filed; a confirmation becomes an item; a statement answers whatever the user asked about it. Then reply in one or two lines with what it is and what you did or need. Never ask the user to paste what is already here.)";

  let session = await currentChatSession(t);
  if (session && !session.pending_kind && chatSessionExhausted(session)) session = undefined; // roll over to a fresh task
  // A bill, a statement, a photo of something: reading it well is judgment work, so it runs on the
  // strong model whatever tier the thread started on (never down mid-conversation).
  await loadModelHistory();
  const lifted = session ? atLeastModel(session.model ?? "", images ? visionTier("task", t) : "task", t) : undefined;
  if (session && lifted) await updateSession(session.id, { model: lifted });
  if (!session) session = await startChatSession(t, `${text}\n${handle}`, images);
  else if (session.pending_kind) {
    await answerPendingWith(session, isImage ? "a photo" : "a file");
    await appendUserMessage(session, stampMessage(t, `${text}\n(This is their answer to what you were waiting for. If it shows a verification code, enter it now.)`, "chat"), images);
  } else {
    // Mid-task or idle: the attachment may be the thing the agent needs (a code that was texted, the
    // bill it could not reach on the site) or a document to file.
    await appendUserMessage(session, stampMessage(t, `${text}\n${handle}`, "chat"), images);
  }
  await kick(session.id);
  return res.status(200).json({ session_id: session.id });
}
