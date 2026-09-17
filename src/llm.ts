import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log, errText } from "./log.js";

/**
 * One place that talks to Claude. Streaming for every request (long tool loops never hit HTTP timeouts),
 * adaptive thinking, prompt caching on the system prompt and the conversation tail, server-side refusal
 * fallbacks, and a price table so every call is booked to the business that made it.
 */
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ToolDef = Anthropic.Beta.BetaTool;
export type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
export type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type ImageBlockParam = Anthropic.Beta.BetaImageBlockParam;
export type Message = Anthropic.Beta.BetaMessage;

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  if (!client) {
    if (!config.llm.apiKey()) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey: config.llm.apiKey(), maxRetries: 3, timeout: 15 * 60_000 });
  }
  return client;
}

/** $/MTok: input, output, cache write, cache read. Unknown models fall back to Opus pricing (over-estimate, never under). */
const PRICES: Array<[RegExp, [number, number, number, number]]> = [
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-5/, [5, 25, 6.25, 0.5]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet-5/, [2, 10, 2.5, 0.2]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku/, [1, 5, 1.25, 0.1]],
];

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function costCents(model: string, u: Usage): number {
  const p = PRICES.find(([re]) => re.test(model))?.[1] ?? [5, 25, 6.25, 0.5];
  const usd = (u.input * p[0] + u.output * p[1] + u.cacheWrite * p[2] + u.cacheRead * p[3]) / 1_000_000;
  return Math.round(usd * 100 * 1000) / 1000;
}

export function usageOf(m: Message): Usage {
  return {
    input: m.usage.input_tokens ?? 0,
    output: m.usage.output_tokens ?? 0,
    cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
    cacheRead: m.usage.cache_read_input_tokens ?? 0,
  };
}

export interface CompleteOptions {
  model: string;
  system: Array<{ text: string; cache?: "1h" | "5m" }>;
  messages: MessageParam[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  onText?: (soFar: string) => void;
  signal?: AbortSignal;
}

export interface Completion {
  message: Message;
  usage: Usage;
  costCents: number;
  model: string;
  text: string;
  toolUses: ToolUseBlock[];
}

/** Injected for tests: replaces the network call. */
export let completeImpl: ((o: CompleteOptions) => Promise<Completion>) | undefined;
export function setCompleteImpl(fn: typeof completeImpl): void {
  completeImpl = fn;
}

export function textOf(m: Message): string {
  return m.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function complete(o: CompleteOptions): Promise<Completion> {
  if (completeImpl) return completeImpl(o);
  const system = o.system.map((s) => ({
    type: "text" as const,
    text: s.text,
    ...(s.cache ? { cache_control: { type: "ephemeral" as const, ...(s.cache === "1h" ? { ttl: "1h" as const } : {}) } } : {}),
  }));
  const useFallbacks = config.llm.fallbacks();
  const params = {
    model: o.model,
    max_tokens: o.maxTokens ?? config.llm.maxTokens(),
    system,
    messages: o.messages,
    ...(o.tools?.length ? { tools: o.tools } : {}),
    ...(o.toolChoice ? { tool_choice: { type: o.toolChoice } as Anthropic.Beta.BetaToolChoice } : {}),
    thinking: { type: "adaptive" as const },
    output_config: { effort: o.effort ?? config.llm.effort() },
    // Auto-caches the conversation tail on top of the explicit system-prompt breakpoints.
    cache_control: { type: "ephemeral" as const },
  };
  const attempt = async (withFallbacks: boolean): Promise<Message> => {
    const stream = anthropic().beta.messages.stream(
      {
        ...params,
        ...(withFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as unknown as Anthropic.Beta.BetaFallbacksParam } : {}),
      },
      { signal: o.signal },
    );
    if (o.onText) {
      let acc = "";
      stream.on("text", (delta) => {
        acc += delta;
        o.onText!(acc);
      });
    }
    return stream.finalMessage();
  };
  let message: Message;
  try {
    message = await attempt(useFallbacks);
  } catch (e) {
    // A deployment that does not accept the fallbacks beta still works; retry once without it.
    if (useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
      log.warn("llm", "fallbacks rejected; retrying without", { err: errText(e) });
      message = await attempt(false);
    } else throw e;
  }
  const usage = usageOf(message);
  return {
    message,
    usage,
    costCents: costCents(message.model || o.model, usage),
    model: message.model || o.model,
    text: textOf(message),
    toolUses: message.content.filter((b): b is ToolUseBlock => b.type === "tool_use"),
  };
}

/** Rough token estimate for pruning decisions (chars / 3.5 is close enough for English plus markup). */
export function estimateTokens(messages: MessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input).length + 40;
        else if (b.type === "tool_result") {
          if (typeof b.content === "string") chars += b.content.length;
          else for (const c of b.content ?? []) chars += c.type === "text" ? c.text.length : c.type === "image" ? 5000 : 200;
        } else if (b.type === "image") chars += 5000;
        else chars += 200;
      }
  }
  return Math.ceil(chars / 3.5);
}

/** Small structured call for classification and summaries on the fast model; returns parsed JSON or undefined. */
export async function classify<T>(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<T | undefined> {
  const c = await complete({
    model: opts.model ?? config.llm.fastModel(),
    system: [{ text: system, cache: "5m" }],
    messages: [{ role: "user", content: user }],
    maxTokens: opts.maxTokens ?? 2000,
    effort: "low",
  });
  const text = c.text;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return undefined;
  }
}

export { Anthropic };
