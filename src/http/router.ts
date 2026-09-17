import type { IncomingMessage, ServerResponse } from "node:http";
import { log, errText } from "../log.js";

/** A small router: method + path pattern (":id" params), JSON or raw bodies, one error shape. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  raw: Buffer;
  body: Record<string, unknown>;
  userId?: string;
  json: (data: unknown, status?: number) => void;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;
interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const MAX_BODY = 40 * 1024 * 1024;

export class Router {
  private routes: Route[] = [];
  constructor(private readonly resolveUser: (req: IncomingMessage) => string | undefined) {}

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
  }
  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  patch = (p: string, h: Handler) => this.add("PATCH", p, h);
  del = (p: string, h: Handler) => this.add("DELETE", p, h);

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (r.parts[i].startsWith(":")) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (r.parts[i] !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const m = this.match(req.method ?? "GET", url.pathname);
    if (!m) return false;
    const c: Ctx = {
      req,
      res,
      method: req.method ?? "GET",
      path: url.pathname,
      params: m.params,
      query: url.searchParams,
      raw: Buffer.alloc(0),
      body: {},
      userId: this.resolveUser(req),
      json: (data, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
      },
    };
    try {
      if (c.method !== "GET" && c.method !== "HEAD") {
        c.raw = await readBody(req);
        const type = String(req.headers["content-type"] ?? "");
        if (c.raw.length && /json/i.test(type)) c.body = JSON.parse(c.raw.toString("utf8")) as Record<string, unknown>;
      }
      const out = await m.route.handler(c);
      if (!res.writableEnded) c.json(out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error("http", `${c.method} ${c.path}`, e);
      if (!res.writableEnded) c.json({ error: errText(e) }, status);
    }
    return true;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > MAX_BODY) throw new HttpError(413, "payload too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export const str = (v: unknown, max = 100_000): string => (v == null ? "" : String(v)).slice(0, max);
export const need = (v: unknown, name: string): string => {
  const s = str(v).trim();
  if (!s) throw new HttpError(400, `${name} is required`);
  return s;
};
