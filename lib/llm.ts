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

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

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

export function resolveModel(model: string): { provider: Provider; model: string } {
  for (const [prefix, p] of Object.entries(providers())) {
    if (model.startsWith(prefix)) return { provider: { baseUrl: p.base_url.replace(/\/$/, ""), apiKey: p.api_key }, model: model.slice(prefix.length) };
  }
  const k = process.env.LLM_API_KEY;
  if (!k) throw new Error("LLM_API_KEY is not set");
  return { provider: { baseUrl: (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""), apiKey: k }, model };
}

export class LLMError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
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
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4000,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = false;
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
    const res = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LLMError(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 500), res.status, true);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new LLMError(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 1000), res.status, false);
    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message: ChatMessage; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
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
        cached_tokens: data.usage?.prompt_tokens_details?.cached_tokens,
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

export function costCents(model: string, usage: Usage): number {
  const p = priceFor(model);
  const cents = ((usage.prompt_tokens * p.in + usage.completion_tokens * p.out) / 1_000_000) * 100;
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
