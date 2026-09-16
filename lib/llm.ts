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
export type ContentPart = { type: "text"; text: string; cache_control?: CacheControl } | { type: "image_url"; image_url: { url: string } } | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Instant emoji acknowledgement shown on a user message in the chat page; never sent to the model. */
  reaction?: string;
  /** A UI-only bubble (the instant "on it" line): shown in chat, never sent to the model. */
  ephemeral?: boolean;
  /** When the message was written (ISO). Set on everything the user sends and the agent says; the chat page shows it. */
  at?: string;
  /** The earlier bubble this message replies to (UI-only; the model gets the quote as a "Re:" line in the text). */
  quote?: MessageQuote;
  /** What the model call that produced this assistant message cost, in cents (fractional). Never sent to the provider. */
  cost?: number;
  /** A draft reply the host sent back to the model (an offer, an unverified figure, a missing site note): the model still sees it, the chat page never shows it. */
  superseded?: boolean;
  /** A stable per-customer context block (facts, notes) that gets its own prompt-cache breakpoint. Working-copy only. */
  cacheBoundary?: boolean;
  /** Screenshot previews attached to this message's tool calls (checkpoint approvals), by call id -> receipt id. */
  previews?: Record<string, string>;
}

export interface MessageQuote {
  /** Chat item id of the quoted bubble ("<session>-<index>"). */
  id: string;
  who: "user" | "agent";
  text: string;
}

/** Only the fields providers know; UI-only bubbles (reactions, the "on it" ack) stay out of the request. */
export function forProvider(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.ephemeral)
    .map(({ role, content, name, tool_calls, tool_call_id }) => ({ role, content, ...(name ? { name } : {}), ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) }));
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
  /** The upstream provider that served the call (OpenRouter reports it). */
  provider?: string;
  /** Milliseconds to the first streamed token. */
  ttft_ms?: number;
}

// ---------------- provider pinning: the provider with the best first-token time for each model, from our own telemetry
let ranking = new Map<string, string[]>();
let rankingAt = 0;
const RANKING_TTL = 10 * 60_000;
/** Refresh the per-model provider order from usage_events (p50 first-token time over 7 days, 10+ calls); never blocks a call. */
export async function refreshProviderRanking(): Promise<void> {
  if ((process.env.LLM_PROVIDER_PINNING ?? "on") === "off") return;
  rankingAt = Date.now();
  try {
    const { q } = await import("./db.js");
    const rows = await q<{ model: string; provider: string; p50: string }>(
      "select model, provider, percentile_cont(0.5) within group (order by ttft_ms)::text as p50 from usage_events where created_at > now() - interval '7 days' and ttft_ms is not null and provider is not null group by model, provider having count(*) >= 10 order by model, 3",
    );
    const next = new Map<string, string[]>();
    for (const r of rows) next.set(r.model, [...(next.get(r.model) ?? []), r.provider]);
    ranking = next;
  } catch {
    /* telemetry is optional */
  }
}
export function providerOrderFor(model: string): string[] | undefined {
  if (Date.now() - rankingAt > RANKING_TTL) void refreshProviderRanking();
  const order = ranking.get(model);
  return order && order.length > 1 ? order.slice(0, 3) : undefined;
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

/**
 * True when calls go to Google's own Gemini endpoint: LLM_PROVIDER=gemini, or a GEMINI_API_KEY with no
 * LLM_API_KEY, or an LLM_BASE_URL pointing at Google. With both keys set, OpenRouter is the default
 * because it fronts every model and normalizes tool schemas.
 */
/** Whether this model id is served through OpenRouter (whose PDF parser plugin the OCR path uses). */
export function providerIsOpenRouter(model: string): boolean {
  try {
    return resolveModel(modelList(model)[0] ?? model).provider.baseUrl.includes("openrouter.ai");
  } catch {
    return false;
  }
}

export function geminiDirect(): boolean {
  if (process.env.LLM_PROVIDER === "gemini") return !!process.env.GEMINI_API_KEY;
  if (process.env.LLM_PROVIDER === "openrouter") return false;
  if (process.env.LLM_API_KEY) return (process.env.LLM_BASE_URL ?? "").includes("generativelanguage.googleapis.com");
  return !!process.env.GEMINI_API_KEY;
}

/** Google's function-calling schema is a subset of JSON Schema: no additionalProperties, objects need properties. */
function geminiSafeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSafeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = geminiSafeSchema(v);
  }
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

export function resolveModel(model: string): { provider: Provider; model: string } {
  for (const [prefix, p] of Object.entries(providers())) {
    if (model.startsWith(prefix)) return { provider: { baseUrl: p.base_url.replace(/\/$/, ""), apiKey: p.api_key }, model: model.slice(prefix.length) };
  }
  // Google direct: GEMINI_API_KEY as the only key, or LLM_PROVIDER=gemini.
  if (process.env.GEMINI_API_KEY && (process.env.LLM_PROVIDER === "gemini" || !process.env.LLM_API_KEY)) {
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
  // The per-customer context block sits right after the shared prompt: its own breakpoint means a
  // customer's facts changing never invalidates the prompt every customer shares.
  if (out[1]?.cacheBoundary && out[1].content) mark(out[1]);
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

/** "a,b,c" -> primary a with fallbacks b and c (OpenRouter tries the next when one is down or rate-limited). */
export function modelList(spec: string): string[] {
  return spec.split(",").map((m) => m.trim()).filter(Boolean);
}

/** OpenRouter rejects a `models` fallback array longer than this. */
const OPENROUTER_MODELS_CAP = Number(process.env.OPENROUTER_MODELS_CAP ?? 3);

/** Set once the account's OpenRouter model restrictions reject an auto-injected chain; then we stop injecting. */
let openRouterRestricted = false;

/**
 * Fit the fallback chain within OpenRouter's cap while keeping it useful: the primary, then the
 * first alternatives, and always openrouter/auto (a catch-all over every model) as the final slot
 * when the chain has one. So [primary, a, b, c, auto] with cap 3 becomes [primary, a, auto].
 */
export function capModels(models: string[], cap = OPENROUTER_MODELS_CAP): string[] {
  if (models.length <= cap) return models;
  const auto = models.find((m) => m.startsWith("openrouter/"));
  const head = models.filter((m) => m !== auto).slice(0, auto ? cap - 1 : cap);
  return auto ? [...head, auto] : head;
}

/** How OpenRouter picks among the providers serving a model: LLM_SORT=price (default), throughput or latency. */
function providerSort(): "price" | "throughput" | "latency" {
  // Speed first: the provider serving this model fastest, not the cheapest one (LLM_SORT=price to flip).
  const v = (process.env.LLM_SORT ?? "throughput").toLowerCase();
  return v === "price" || v === "latency" ? v : "throughput";
}

export async function complete(opts: {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** "none" forces a plain text reply (a wrap-up); tools stay in the request because Anthropic requires them when the history has tool calls. */
  toolChoice?: "auto" | "none";
  /** Called with the reply text so far as it streams, so the page can show it before the completion ends. */
  onText?: (text: string) => void;
  /** Called with each tool call as soon as its JSON is complete in the stream (the next call has started, or the stream ended), so read-only work can begin before the completion returns. */
  onToolCall?: (call: ToolCall) => void;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Provider plugins (OpenRouter's file-parser for PDFs); passed through as-is. */
  plugins?: unknown[];
}): Promise<Completion> {
  let ids = modelList(opts.model);
  let { provider, model } = resolveModel(ids[0] ?? opts.model);
  const isOpenRouter = () => provider.baseUrl.includes("openrouter.ai");
  if (isOpenRouter()) {
    // Every model OpenRouter serves is fair game: a tier with one or two ids gets the closest
    // alternatives from the catalog behind it, and an id the catalog does not know is replaced
    // rather than failing every request.
    const known = await catalog();
    // Once the account's model restrictions have rejected an auto-injected chain, stop injecting for
    // the rest of this worker: the extra models just cost a wasted request and a retry every call.
    if (known.length && process.env.LLM_AUTO_FALLBACK !== "off" && !openRouterRestricted) {
      const configured = ids.map((id) => resolveModel(id).model);
      const valid = configured.filter((id) => id.startsWith("openrouter/") || known.some((m) => m.id === id));
      if (valid.length < configured.length) console.error(`[llm] unknown model id(s) ${configured.filter((id) => !valid.includes(id)).join(", ")}; using catalog alternatives`);
      // No valid id at all: size the chain from the unknown one, then drop it.
      const chain = valid.length ? withFallbacks(valid, known) : withFallbacks([configured[0]], known).slice(1);
      if (chain.length && chain[0] !== model) console.error(`[llm] ${model} is not on OpenRouter; running on ${chain[0]}`);
      if (chain.length) {
        ids = chain;
        model = chain[0];
      }
    }
  }
  const started = Date.now();
  let cacheLevel: "full" | "system" | "none" = wantsCacheMarkers(model) ? "full" : "none";
  const body: Record<string, unknown> = {
    model,
    messages: withCacheMarkers(forProvider(opts.messages), cacheLevel),
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4000,
  };
  if (opts.plugins?.length) body.plugins = opts.plugins;
  if (opts.tools?.length) {
    body.tools = provider.baseUrl.includes("generativelanguage.googleapis.com") ? (geminiSafeSchema(opts.tools) as ToolDef[]) : opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
    // Only OpenAI itself gets this flag: on OpenRouter it narrows the provider pool, elsewhere it may be rejected.
    if (provider.baseUrl.includes("api.openai.com")) body.parallel_tool_calls = false;
  }
  if (isOpenRouter()) {
    // Cheapest (or fastest, LLM_SORT) healthy provider for the chosen model; fall back to others if it fails.
    body.provider = { sort: providerSort(), allow_fallbacks: true };
    // Our own measurements beat the platform's sort: the providers that answered this model fastest, first.
    const order = providerOrderFor(model);
    if (order) (body.provider as Record<string, unknown>).order = order;
    body.usage = { include: true };
    // The model list is OpenRouter's fallback chain: the next model answers when the first is down,
    // rate-limited, or rejects the request. OpenRouter caps this array at OPENROUTER_MODELS_CAP, so
    // keep the primary, one real alternative, and openrouter/auto (a catch-all) when there is one.
    if (ids.length > 1) body.models = capModels(ids.map((id) => resolveModel(id).model));
  }
  if (opts.onText) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` };
  if (isOpenRouter()) {
    headers["HTTP-Referer"] = process.env.APP_URL || "https://example.com";
    headers["X-Title"] = process.env.ASSISTANT_NAME || "Pete";
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
    // Out of credits, or credits held by in-flight requests (parallel tasks): wait for them to settle.
    if (res.status === 402) {
      const text = await res.text().catch(() => "");
      lastErr = new LLMError("The model provider account is out of credits (OpenRouter 402). Add credits at openrouter.ai/credits, then say \"try again\".", 402, false);
      console.error(`[llm] ${model}: 402 ${text.slice(0, 200)}`);
      if (/in-flight/i.test(text) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LLMError(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 500), res.status, true);
      console.error(`[llm] ${model}: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // OpenRouter found no provider for this exact parameter set: retry without routing preferences.
      if (res.status === 404 && body.provider && /No endpoints/i.test(text)) {
        console.error(`[llm] ${model}: no endpoint for the routing preferences, retrying without them`);
        delete body.provider;
        attempt--;
        continue;
      }
      // The account's OpenRouter model restrictions (an allowlist) reject some models in the chain:
      // drop the auto-injected fallbacks and run the configured primary alone, which is the one the
      // user chose and is normally on their allowlist. If that still fails, drop routing preferences.
      if (res.status === 404 && /model restrictions|No models match|no allowed providers/i.test(text)) {
        if (Array.isArray(body.models)) {
          console.error(`[llm] ${model}: model restrictions rejected the fallback chain, retrying with the primary only`);
          openRouterRestricted = true; // this account has a model allowlist; stop auto-injecting fallbacks
          delete body.models;
          attempt--;
          continue;
        }
        if (body.provider) {
          delete body.provider;
          attempt--;
          continue;
        }
      }
      // OpenRouter (or an org) allows fewer fallback models than we sent: trim and retry.
      if (res.status === 400 && Array.isArray(body.models) && /models['"\s]*array|too many models|\d+ items or fewer/i.test(text)) {
        const n = Number(text.match(/(\d+) items or fewer/i)?.[1] ?? OPENROUTER_MODELS_CAP);
        const trimmed = capModels(body.models as string[], Math.max(1, n));
        if (trimmed.length <= 1) delete body.models;
        else body.models = trimmed;
        console.error(`[llm] ${model}: models array too long, retrying with ${trimmed.length}`);
        attempt--;
        continue;
      }
      // A provider that rejects cache markers gets the same request with fewer of them, then none.
      if (res.status === 400 && cacheLevel !== "none" && /cache_control|content|invalid/i.test(text)) {
        cacheLevel = cacheLevel === "full" ? "system" : "none";
        body.messages = withCacheMarkers(forProvider(opts.messages), cacheLevel);
        attempt--;
        continue;
      }
      console.error(`[llm] ${model}: ${res.status} ${text.slice(0, 300)}`);
      throw new LLMError(`${res.status} ${text}`.slice(0, 1000), res.status, false);
    }
    let data: StreamedResult;
    if (opts.onText) {
      try {
        data = await readStream(res, opts.onText, { onToolCall: opts.onToolCall, firstTokenMs: Number(process.env.LLM_FIRST_TOKEN_MS ?? 10_000) });
      } catch (e) {
        if (e instanceof FirstTokenTimeout) {
          // The provider accepted the request but has not started answering: a slow or wedged upstream.
          // Move to the next model in the chain (or retry this one) instead of waiting out the full timeout.
          console.error(`[llm] ${model}: no first token within ${e.ms}ms${ids.length > 1 ? `; moving to ${resolveModel(ids[1]).model}` : ""}`);
          if (ids.length > 1) {
            ids = ids.slice(1);
            model = resolveModel(ids[0]).model;
            body.model = model;
            if (isOpenRouter()) {
              if (ids.length > 1) body.models = capModels(ids.map((id) => resolveModel(id).model));
              else delete body.models;
            }
            attempt--;
          }
          lastErr = new LLMError(`no first token within ${e.ms}ms`, undefined, true);
          continue;
        }
        throw new LLMError(`stream failed: ${e instanceof Error ? e.message : String(e)}`, 200, true);
      }
    } else data = (await res.json()) as StreamedResult;
    if (data.error) throw new LLMError(data.error.message ?? "provider error", 200, false);
    const choice = data.choices?.[0];
    if (!choice) throw new LLMError("empty completion", 200, true);
    const msg = choice.message;
    console.log(`[llm] ${data.model ?? model}: ${((Date.now() - started) / 1000).toFixed(1)}s in=${data.usage?.prompt_tokens ?? "?"} cached=${data.usage?.prompt_tokens_details?.cached_tokens ?? 0} out=${data.usage?.completion_tokens ?? "?"}${typeof data.usage?.cost === "number" ? ` $${data.usage.cost.toFixed(4)}` : ""}`);
    // Some providers return tool_calls with arguments as objects; normalize to strings.
    for (const tc of msg.tool_calls ?? []) {
      if (typeof (tc.function as { arguments: unknown }).arguments !== "string") tc.function.arguments = JSON.stringify(tc.function.arguments);
      if (!tc.id) tc.id = `call_${Math.random().toString(36).slice(2, 10)}`;
      tc.type = "function";
    }
    return {
      provider: data.provider,
      ttft_ms: data.ttft_ms,
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

type StreamedResult = {
  model?: string;
  provider?: string;
  ttft_ms?: number;
  choices?: Array<{ message: ChatMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number }; cache_read_input_tokens?: number };
  error?: { message?: string };
};

/** The provider accepted the request but sent nothing within the first-token window. */
export class FirstTokenTimeout extends Error {
  constructor(public ms: number) {
    super(`no first token within ${ms}ms`);
  }
}

/**
 * Assemble a streamed chat completion (SSE "data:" chunks) into the same shape as a plain one,
 * calling `onText` with the reply so far as text arrives. Tool-call fragments are merged by index;
 * a call is handed to `onToolCall` the moment it is complete (the next call starts, the choice
 * finishes, or the stream ends), so the loop can start read-only work while the model is still talking.
 */
export async function readStream(res: Response, onText: (text: string) => void, opts: { onToolCall?: (call: ToolCall) => void; firstTokenMs?: number } = {}): Promise<StreamedResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const emitted = new Set<number>();
  const emitReady = (upTo: number) => {
    if (!opts.onToolCall) return;
    for (let i = 0; i < upTo && i < calls.length; i++) {
      const c = calls[i];
      if (!c || emitted.has(i) || !c.function.name) continue;
      try {
        JSON.parse(c.function.arguments || "{}");
      } catch {
        continue;
      }
      emitted.add(i);
      try {
        opts.onToolCall({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } });
      } catch {
        /* the caller's problem */
      }
    }
  };
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let model: string | undefined;
  let provider: string | undefined;
  let ttft: number | undefined;
  const started = Date.now();
  let finish: string | undefined;
  let usage: StreamedResult["usage"];
  let error: string | undefined;
  const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  let lastEmit = 0;
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j: { model?: string; choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; usage?: StreamedResult["usage"]; error?: { message?: string } };
    try {
      j = JSON.parse(payload);
    } catch {
      return;
    }
    if (j.error?.message) error = j.error.message;
    if (j.model) model = j.model;
    if ((j as { provider?: string }).provider) provider = (j as { provider?: string }).provider;
    if (ttft === undefined && (j.choices?.[0]?.delta?.content || j.choices?.[0]?.delta?.tool_calls?.length)) ttft = Date.now() - started;
    if (j.usage) usage = j.usage;
    const c = j.choices?.[0];
    if (!c) return;
    if (c.finish_reason) {
      finish = c.finish_reason;
      emitReady(calls.length);
    }
    if (typeof c.delta?.content === "string" && c.delta.content) {
      text += c.delta.content;
      if (Date.now() - lastEmit > 400) {
        lastEmit = Date.now();
        onText(text);
      }
    }
    for (const tc of c.delta?.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      if (!calls[i]) emitReady(i); // a new call begins: every earlier one is complete
      calls[i] ??= { id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: "", arguments: "" } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
  };
  let first = true;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    if (first && opts.firstTokenMs && opts.firstTokenMs > 0) {
      // Nothing at all within the window: the upstream is wedged; the caller fails over.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FirstTokenTimeout(opts.firstTokenMs!)), opts.firstTokenMs);
      });
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      } finally {
        clearTimeout(timer);
      }
    } else chunk = await reader.read();
    first = false;
    const { value, done } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handle(buf.trim());
  if (error) return { error: { message: error } };
  if (text) onText(text);
  emitReady(calls.length);
  const tool_calls = calls.filter(Boolean);
  return { model, provider, ttft_ms: ttft, usage, choices: [{ message: { role: "assistant", content: text || null, tool_calls: tool_calls.length ? tool_calls : undefined }, finish_reason: finish ?? "stop" }] };
}

// ---------------------------------------------------------------- Model catalog

export interface CatalogModel {
  id: string;
  name: string;
  /** USD per million tokens. */
  in: number;
  out: number;
  context: number;
  tools: boolean;
  vision: boolean;
}

let catalogCache: { at: number; models: CatalogModel[] } | undefined;
const CATALOG_TTL = 6 * 3_600_000;

/**
 * Every model OpenRouter serves, with live prices and capabilities, so any id works in MODEL_* and
 * is priced correctly, with no table to maintain. Cached per worker; empty when not on OpenRouter
 * or the catalog is unreachable.
 */
export async function catalog(): Promise<CatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.models;
  const base = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  if (!base.includes("openrouter.ai") || !process.env.LLM_API_KEY) return [];
  try {
    // On a cold start this sits in front of the first model call: give it three seconds, not eight.
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return catalogCache?.models ?? [];
    const data = (await res.json()) as { data?: Array<{ id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] }> };
    const models: CatalogModel[] = (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      in: Number(m.pricing?.prompt ?? 0) * 1_000_000,
      out: Number(m.pricing?.completion ?? 0) * 1_000_000,
      context: m.context_length ?? 0,
      tools: (m.supported_parameters ?? []).includes("tools"),
      vision: (m.architecture?.input_modalities ?? []).includes("image"),
    }));
    catalogCache = { at: Date.now(), models };
    return models;
  } catch (err) {
    console.error(`[llm] catalog: ${err instanceof Error ? err.message : String(err)}`);
    return catalogCache?.models ?? [];
  }
}

/** Vendors whose models are reliable tool callers, most trusted first; the chain takes one model per vendor. */
const FALLBACK_VENDORS = ["google", "anthropic", "openai", "deepseek", "x-ai", "qwen", "moonshotai", "z-ai", "mistralai", "meta-llama"];
const FALLBACK_MAX = Number(process.env.LLM_AUTO_FALLBACK_COUNT ?? 3);
/** Variants and specialised models that make poor general agents: batch/free tiers, previews, coders, vision-only, tiny. */
const NOT_A_FALLBACK = /[:]|preview|exp\b|-exp-|beta|thinking|nano|gemma|oss|-vl|vision|-code|coder|codestral|-v\b|build|guard|saba|voxtral|embed|audio|tts|image|search|-8b|-9b|-14b|-3b|-7b|\d{4}-\d{2}-\d{2}$|-\d{4}$/i;

/**
 * The configured ids followed by the catalog models a person would pick as stand-ins for the
 * primary: tool-capable, image-capable when the primary is, from a trusted vendor, a plain id, and
 * priced between half and two and a half times the primary. One model per vendor in order of trust,
 * the cheapest one at or above the primary's price (a slightly stronger model, never a much weaker
 * one), else the strongest below it. `openrouter/auto` closes the chain so a request is answered by
 * something even when every named model is down. An unknown or unpriced primary is treated as a
 * mid-priced task model.
 */
export function withFallbacks(configured: string[], models: CatalogModel[], max = FALLBACK_MAX): string[] {
  const primary = configured[0];
  if (!primary || primary.startsWith("openrouter/")) return configured;
  const p = models.find((m) => m.id === primary);
  const price = p && p.in + p.out > 0 ? p.in + p.out : 3;
  const vision = p?.vision ?? true;
  const vendorOf = (id: string) => id.split("/")[0];
  const cost = (m: CatalogModel) => m.in + m.out;
  const candidates = models.filter(
    (m) =>
      !configured.includes(m.id) &&
      m.tools &&
      (!vision || m.vision) &&
      FALLBACK_VENDORS.includes(vendorOf(m.id)) &&
      !NOT_A_FALLBACK.test(m.id.slice(m.id.indexOf("/") + 1)) &&
      m.in > 0 &&
      m.context >= 100_000 &&
      cost(m) >= price / 2 &&
      cost(m) <= price * 2.5,
  );
  const out = [...configured];
  for (const vendor of FALLBACK_VENDORS) {
    if (out.length >= configured.length + max) break;
    const own = candidates.filter((m) => vendorOf(m.id) === vendor).sort((a, b) => cost(a) - cost(b));
    const pick = own.find((m) => cost(m) >= price) ?? own[own.length - 1];
    if (pick) out.push(pick.id);
  }
  if (models.some((m) => m.id === "openrouter/auto")) out.push("openrouter/auto");
  return out;
}

/** Live prices for models the static table does not know; filled by warmCatalog(). */
const livePrices = new Map<string, { in: number; out: number }>();
const liveVision = new Set<string>();

/** Load the catalog once per worker so pricing and vision checks know every model. */
export async function warmCatalog(): Promise<void> {
  for (const m of await catalog()) {
    livePrices.set(m.id, { in: m.in, out: m.out });
    if (m.vision) liveVision.add(m.id);
  }
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
  if (key) return table[key];
  const live = livePrices.get(model) ?? livePrices.get(model.replace(/:[a-z]+$/, ""));
  return live ?? { in: 2, out: 10 }; // unknown model: assume Sonnet-class so caps still bite
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
  const primary = modelList(model)[0] ?? model;
  if (liveVision.has(primary) || liveVision.has(resolveModelName(primary))) return true;
  const list = (process.env.VISION_MODELS ?? "gemini,gpt-4o,gpt-5,claude,qwen-vl,pixtral,llama-4").split(",").map((s) => s.trim().toLowerCase());
  return list.some((s) => s && primary.toLowerCase().includes(s));
}

/** Rough token estimate for context budgeting. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    // A screenshot costs far more than a snippet of text; count it near its real token weight so a
    // vision-heavy task triggers compaction instead of quietly re-sending huge uncached contexts.
    else for (const p of m.content ?? []) chars += p.type === "text" ? p.text.length : 5000;
    for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length + 40;
  }
  return Math.round(chars / 3.5);
}
