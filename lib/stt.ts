/**
 * Voice notes -> text through any Whisper-compatible /audio/transcriptions endpoint
 * (OpenAI, Groq, DeepInfra, a self-hosted whisper server). Optional: without STT_* the chat page
 * falls back to browser dictation.
 */
export function sttConfigured(): boolean {
  return !!(process.env.STT_BASE_URL && process.env.STT_API_KEY);
}

export async function transcribe(audio: Buffer, filename: string, mimeType: string): Promise<string> {
  const base = (process.env.STT_BASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.STT_API_KEY ?? "";
  if (!base || !key) throw new Error("voice notes are not configured (STT_BASE_URL, STT_API_KEY)");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append("model", process.env.STT_MODEL ?? "whisper-1");
  form.append("response_format", "json");
  const res = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
