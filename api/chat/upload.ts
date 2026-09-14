import type { VercelRequest, VercelResponse } from "@vercel/node";
import { chatAuthorized } from "../../lib/chat-auth.js";
import { currentChatSession, startChatSession } from "../../lib/chat.js";
import { addFileToSession, sendUserMessage } from "../../lib/anthropic.js";
import { stampMessage } from "../../lib/transcript.js";

export const config = { api: { bodyParser: { sizeLimit: "6mb" } } };

/**
 * POST { filename, mimeType, data (base64) } -> mounts the file in the current chat session's
 * sandbox under /workspace/inbox/ and tells the agent it is there. Photos of a damaged item,
 * a PDF from a vendor, anything the agent needs as evidence.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (!chatAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const body = req.body as { filename?: string; mimeType?: string; data?: string };
  if (!body?.filename || !body?.data) return res.status(400).json({ error: "filename and data required" });
  const content = Buffer.from(body.data, "base64");
  if (content.length > 4 * 1024 * 1024) return res.status(413).json({ error: "file too large (4 MB max); email it instead" });

  let session = await currentChatSession();
  if (!session) {
    session = await startChatSession(`(The user is attaching a file: ${body.filename}. Wait for their message about it.)`);
  }
  const mountPath = await addFileToSession(session.id, { filename: body.filename, mimeType: body.mimeType ?? "application/octet-stream", content });
  await sendUserMessage(session.id, stampMessage(`(Attached file: ${body.filename}, available at ${mountPath}. Use it when relevant; no reply needed until I say more.)`, "chat"));
  return res.status(200).json({ session_id: session.id, path: mountPath });
}
