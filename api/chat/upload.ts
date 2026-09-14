import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../lib/auth.js";
import { currentChatSession, startChatSession } from "../../lib/chat.js";
import { kick } from "../../lib/runtime.js";
import { appendUserMessage } from "../../lib/sessions.js";
import { stampMessage } from "../../lib/transcript.js";
import { sttConfigured, transcribe } from "../../lib/stt.js";

export const config = { api: { bodyParser: { sizeLimit: "6mb" } } };

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
    if (!session) session = await startChatSession(t, `(voice note) ${spoken}`);
    else await appendUserMessage(session, stampMessage(t, `(voice note) ${spoken}`, "chat"));
    await kick(session.id);
    return res.status(200).json({ session_id: session.id, text: spoken });
  }
  const isImage = mime.startsWith("image/");
  const isText = mime.startsWith("text/") || /json|csv|xml/.test(mime);
  const text = isImage
    ? `(Attached photo: ${body.filename})`
    : isText
      ? `(Attached file ${body.filename}):\n\n${content.toString("utf8").slice(0, 30_000)}`
      : `(Attached file ${body.filename}, ${mime}, ${content.length} bytes. I cannot read this format directly; ask the user to paste the text or send it by email if needed.)`;
  const images = isImage ? [{ mimeType: mime, base64: body.data }] : undefined;

  let session = await currentChatSession(t);
  if (!session) session = await startChatSession(t, `${text}\n(Wait for the user's message about it.)`, images);
  else await appendUserMessage(session, stampMessage(t, `${text}\n(No reply needed until I say more.)`, "chat"), images);
  await kick(session.id);
  return res.status(200).json({ session_id: session.id });
}
