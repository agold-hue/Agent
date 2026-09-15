/**
 * Any OpenAI-compatible chat-completions provider: OpenRouter (one key, every model, price-sorted
 * providers), DeepSeek, Google's Gemini OpenAI endpoint, OpenAI, or Anthropic through OpenRouter.
 * No SDK; plain fetch.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type CacheControl = { type: "ephemeral" };
export type ContentPart = { type: "text"; text: string; cache_control?: CacheControl } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  /** Exact charge reported by the provider (OpenRouter returns it); wins over the price table. */
  cost_usd?: number;
}

export interface Completion {
  message: ChatMessage;
  usage: Usage;
  model: string;
  finish_reason: string;
}

/**
 * Provider resolution. Default: every model goes to LLM_BASE_URL with LLM_API_KEY (OpenRouter).
 * Optional LLM_PROVIDERS routes models by prefix to their own endpoint and key, so e.g. the hard
 * tier can bill directly to Anthropic while cheap tiers stay on OpenRouter or DeepSeek:
 *   LLM_PROVIDERS={"anthropic-direct:":{"base_url":"https://api.anthropic.com/v1","api_key":"sk-ant-..."},
 *                  "deepseek-direct:":{"base_url":"https://api.deepseek.com/v1","api_key":"sk-..."}}
 *   MODEL_HARD=anthropic-direct:claude-sonnet-5
 * The prefix is stripped before the request; the price table matches on the remainder.
 */
interface Provider {
  baseUrl: string;
  apiKey: string;
}

function providers(): Record<string, { base_url: string; api_key: string }> {
  try {
    return process.env.LLM_PROVIDERS ? (JSON.parse(process.env.LLM_PROVIDERS) as Record<string, { base_url: string; api_key: string }>) : {};
  } catch {
    return {};
  }
}

export const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** True when the default provider is Google's own Gemini endpoint (GEMINI_API_KEY shortcut or LLM_BASE_URL). */
export function geminiDirect(): boolean {
  if (process.env.LLM_API_KEY) return (process.env.LLM_BASE_URL ?? "").includes("generativelanguage.googleapis.com");
  return !!process.env.GEMINI_API_KEY;
}

export function resolveModel(model: string): { provider: Provider; model: string } {
  for (const [prefix, p] of Object.entries(providers())) {
    if (model.startsWith(prefix)) return { provider: { baseUrl: p.base_url.replace(/\/$/, ""), apiKey: p.api_key }, model: model.slice(prefix.length) };
  }
  // Shortcut: GEMINI_API_KEY alone routes everything to Google's OpenAI-compatible endpoint.
  if (!process.env.LLM_API_KEY && process.env.GEMINI_API_KEY) {
    return { provider: { baseUrl: GEMINI_OPENAI_URL, apiKey: process.env.GEMINI_API_KEY }, model: model.replace(/^google\//, "") };
  }
  const k = process.env.LLM_API_KEY;
  if (!k) throw new Error("LLM_API_KEY (or GEMINI_API_KEY) is not set");
  const baseUrl = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  // Google's endpoint wants bare ids ("gemini-2.5-flash"), OpenRouter wants "google/gemini-2.5-flash".
  return { provider: { baseUrl, apiKey: k }, model: baseUrl.includes("generativelanguage.googleapis.com") ? model.replace(/^google\//, "") : model };
}

export class LLMError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
}

// ---------------------------------------------------------------- Prompt caching

/** Models that need explicit cache breakpoints. Gemini, DeepSeek and OpenAI cache stable prefixes on their own. */
function wantsCacheMarkers(model: string): boolean {
  return /claude|anthropic/i.test(model) && process.env.PROMPT_CACHE !== "off";
}

/**
 * Two breakpoints, the pattern Anthropic recommends for agents: one after the system prompt (which
 * also covers the tool definitions in front of it) and one on the newest message, so the next call
 * reads the whole conversation so far from cache instead of paying full price for it again.
 * Cached input costs a tenth of the normal rate. Returns copies; the stored messages are untouched.
 */
export function withCacheMarkers(messages: ChatMessage[], level: "full" | "system" | "none"): ChatMessage[] {
  if (level === "none") return messages;
  const out = messages.map((m) => ({ ...m }));
  const mark = (m: ChatMessage) => {
    if (typeof m.content === "string") m.content = [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }];
    else if (Array.isArray(m.content) && m.content.length) {
      const parts = m.content.map((p) => ({ ...p }));
      const last = parts[parts.length - 1];
      if (last.type === "text") last.cache_control = { type: "ephemeral" };
      else parts.push({ type: "text", text: " ", cache_control: { type: "ephemeral" } });
      m.content = parts;
    }
  };
  if (out[0]?.role === "system") mark(out[0]);
  if (level === "full") {
    for (let i = out.length - 1; i > 0; i--) {
      if ((out[i].role === "user" || out[i].role === "tool") && out[i].content) {
        mark(out[i]);
        break;
      }
    }
  }
  return out;
}

export async function complete(opts: {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<Completion> {
  const { provider, model } = resolveModel(opts.model);
  const isOpenRouter = () => provider.baseUrl.includes("openrouter.ai");
  let cacheLevel: "full" | "system" | "none" = wantsCacheMarkers(model) ? "full" : "none";
  const body: Record<string, unknown> = {
    model,
    messages: withCacheMarkers(opts.messages, cacheLevel),
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4000,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
    // Only OpenAI-style endpoints know this flag; Google's compatibility layer may reject unknown fields.
    if (isOpenRouter() || provider.baseUrl.includes("api.openai.com")) body.parallel_tool_calls = false;
  }
  if (isOpenRouter()) {
    // Cheapest healthy provider for the chosen model; fall back to others if it fails.
    body.provider = { sort: "price", allow_fallbacks: true, require_parameters: true };
    body.usage = { include: true };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` };
  if (isOpenRouter()) {
    headers["HTTP-Referer"] = process.env.APP_URL || "https://example.com";
    headers["X-Title"] = "Secretary";
  }

  let lastErr: LLMError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    // A hung provider must fail fast enough for the loop to retry within its slice.
    const signal = opts.signal ?? AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 120_000));
    let res: Response;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      lastErr = new LLMError(`provider unreachable: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      console.error(`[llm] ${model}: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LLMError(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 500), res.status, true);
      console.error(`[llm] ${model}: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A provider that rejects cache markers gets the same request with fewer of them, then none.
      if (res.status === 400 && cacheLevel !== "none" && /cache_control|content|invalid/i.test(text)) {
        cacheLevel = cacheLevel === "full" ? "system" : "none";
        body.messages = withCacheMarkers(opts.messages, cacheLevel);
        attempt--;
        continue;
      }
      console.error(`[llm] ${model}: ${res.status} ${text.slice(0, 300)}`);
      throw new LLMError(`${res.status} ${text}`.slice(0, 1000), res.status, false);
    }
    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message: ChatMessage; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number }; cache_read_input_tokens?: number };
      error?: { message?: string };
    };
    if (data.error) throw new LLMError(data.error.message ?? "provider error", 200, false);
    const choice = data.choices?.[0];
    if (!choice) throw new LLMError("empty completion", 200, true);
    const msg = choice.message;
    // Some providers return tool_calls with arguments as objects; normalize to strings.
    for (const tc of msg.tool_calls ?? []) {
      if (typeof (tc.function as { arguments: unknown }).arguments !== "string") tc.function.arguments = JSON.stringify(tc.function.arguments);
      if (!tc.id) tc.id = `call_${Math.random().toString(36).slice(2, 10)}`;
      tc.type = "function";
    }
    return {
      message: { role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined },
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        cached_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.cache_read_input_tokens ?? 0,
        cost_usd: typeof data.usage?.cost === "number" ? data.usage.cost : undefined,
      },
      model: data.model ?? opts.model,
      finish_reason: choice.finish_reason ?? "stop",
    };
  }
  throw lastErr ?? new LLMError("llm failed", undefined, true);
}

// ---------------------------------------------------------------- Pricing

/** USD per million tokens. Override or extend with MODEL_PRICES='{"model":{"in":0.1,"out":0.4}}'. */
const DEFAULT_PRICES: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-chat": { in: 0.3, out: 1.2 },
  "deepseek/deepseek-flash": { in: 0.3, out: 1.2 },
  "deepseek/deepseek-v4-pro": { in: 1.32, out: 3.96 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "google/gemini-2.5-pro": { in: 1.25, out: 10 },
  "google/gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "google/gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "anthropic/claude-haiku-4.5": { in: 1, out: 5 },
  "anthropic/claude-sonnet-5": { in: 2, out: 10 },
  "anthropic/claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
};

export function priceFor(modelId: string): { in: number; out: number } {
  const model = resolveModelName(modelId);
  let table = DEFAULT_PRICES;
  try {
    if (process.env.MODEL_PRICES) table = { ...DEFAULT_PRICES, ...(JSON.parse(process.env.MODEL_PRICES) as typeof DEFAULT_PRICES) };
  } catch {
    /* ignore bad JSON */
  }
  const key = Object.keys(table).find((k) => model === k || model.endsWith(k) || k.endsWith(model));
  return key ? table[key] : { in: 2, out: 10 }; // unknown model: assume Sonnet-class so caps still bite
}

/** What a cached input token costs relative to a fresh one, per model family. */
function cacheDiscount(model: string): number {
  const m = model.toLowerCase();
  if (/claude|anthropic|deepseek/.test(m)) return 0.1;
  if (/gemini|google/.test(m)) return 0.25;
  if (/gpt|openai/.test(m)) return 0.5;
  return 1;
}

export function costCents(model: string, usage: Usage): number {
  if (usage.cost_usd != null && usage.cost_usd >= 0) return usage.cost_usd * 100;
  const p = priceFor(model);
  const cached = Math.min(usage.cached_tokens ?? 0, usage.prompt_tokens);
  const fresh = usage.prompt_tokens - cached;
  const cents = ((fresh * p.in + cached * p.in * cacheDiscount(model) + usage.completion_tokens * p.out) / 1_000_000) * 100;
  return Math.round(cents * 1000) / 1000;
}

function resolveModelName(modelId: string): string {
  for (const prefix of Object.keys(providers())) if (modelId.startsWith(prefix)) return modelId.slice(prefix.length);
  return modelId;
}

/** Whether we may send screenshots to this model. */
export function supportsVision(model: string): boolean {
  const list = (process.env.VISION_MODELS ?? "gemini,gpt-4o,gpt-5,claude,qwen-vl,pixtral,llama-4").split(",").map((s) => s.trim().toLowerCase());
  return list.some((s) => s && model.toLowerCase().includes(s));
}

/** Rough token estimate for context budgeting. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else for (const p of m.content ?? []) chars += p.type === "text" ? p.text.length : 1500;
    for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length + 40;
  }
  return Math.round(chars / 3.5);
}
