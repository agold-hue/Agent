/**
 * Voice notes -> text through any Whisper-compatible /audio/transcriptions endpoint
 * (OpenAI, Groq, DeepInfra, a self-hosted whisper server). Optional: without STT_* the chat page
 * falls back to browser dictation.
 */

/** Whisper endpoints reject anything much past this; say so plainly rather than sending it. */
const MAX_BYTES = Number(process.env.STT_MAX_BYTES) || 25 * 1024 * 1024;

/** Extensions the phones actually produce: iPhone memos (.m4a), WhatsApp (.opus/.ogg), Android (.amr/.3gp), the app (.webm). */
const AUDIO_EXT = /\.(m4a|m4b|mp3|mpga|mpeg|wav|weba|webm|ogg|oga|opus|amr|aac|flac|3gp|3gpp|caf|aiff?)$/i;

/**
 * Is this attachment someone talking? The mime type is the first word, but mail servers and phones
 * send voice notes as application/octet-stream often enough that the filename gets a vote too.
 * video/webm and video/mp4 are here because that is what a browser recording and an iPhone memo
 * arrive as.
 */
export function isAudio(mimeType: string, filename = ""): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  if (mime === "video/webm" || mime === "video/mp4" || mime === "video/3gpp") return true;
  return AUDIO_EXT.test(filename);
}

export function sttConfigured(): boolean {
  return !!(process.env.STT_BASE_URL && process.env.STT_API_KEY);
}

export async function transcribe(audio: Buffer, filename: string, mimeType: string): Promise<string> {
  const base = (process.env.STT_BASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.STT_API_KEY ?? "";
  if (!base || !key) throw new Error("voice notes are not configured (STT_BASE_URL, STT_API_KEY)");
  if (audio.length > MAX_BYTES) throw new Error(`that note is too long to transcribe (${Math.round(audio.length / 1e6)} MB, ${Math.round(MAX_BYTES / 1e6)} MB max)`);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append("model", process.env.STT_MODEL ?? "whisper-1");
  form.append("response_format", "json");
  // Optional: pin the language when the owner speaks one (better on names and numbers than autodetect).
  if (process.env.STT_LANGUAGE) form.append("language", process.env.STT_LANGUAGE);
  const res = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/**
 * Transcribe without throwing: for the paths that fold a voice note in among other attachments
 * (forwarded mail, a mixed upload), where one unreadable note must not lose the rest of the batch.
 * Returns what was said, or why it could not be heard.
 */
export async function transcribeQuietly(audio: Buffer, filename: string, mimeType: string): Promise<{ text: string; error?: string }> {
  if (!sttConfigured()) return { text: "", error: "transcription is not enabled on this server (STT_*)" };
  try {
    const text = await transcribe(audio, filename, mimeType);
    return text ? { text } : { text: "", error: "nothing audible in it" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[stt] ${filename}: ${error}`);
    return { text: "", error };
  }
}
