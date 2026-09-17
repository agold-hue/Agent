import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { userIdFromCookie } from "../auth.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { registerRoutes, webDir } from "./routes.js";
import { Router } from "./router.js";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

export function startHttp(): http.Server {
  const router = new Router((req) => userIdFromCookie(req.headers.cookie));
  registerRoutes(router);
  const dir = webDir();
  const server = http.createServer(async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      const url = new URL(req.url ?? "/", "http://x");
      let file = url.pathname === "/" ? "/index.html" : url.pathname;
      const abs = path.join(dir, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
      if (!abs.startsWith(dir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        if (url.pathname.startsWith("/api/")) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "not found" }));
        }
        file = "/index.html";
      }
      const target = file === "/index.html" ? path.join(dir, "index.html") : abs;
      res.writeHead(200, { "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      log.error("http", "unhandled", e);
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end("error");
      }
    }
  });
  server.listen(config.port(), () => log.info("http", `listening on ${config.port()}`, { url: config.appUrl() }));
  return server;
}
