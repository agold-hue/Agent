// Vercel cannot host the service (it is a long-running process with a browser inside), but the repo is
// linked to a Vercel project that deploys every push. This makes that deploy a valid static page: it
// redirects to the real service when WORKMATE_URL is set in the Vercel project's environment, and
// otherwise explains where the service runs. Run by vercel.json's buildCommand.
import fs from "node:fs";

const target = (process.env.WORKMATE_URL || "").trim().replace(/\/+$/, "");
const out = "vercel-static";
fs.mkdirSync(out, { recursive: true });
const redirect = target ? `<meta http-equiv="refresh" content="0; url=${target}/">` : "";
const body = target
  ? `<p>Workmate has moved to <a href="${target}/">${target}</a>. Redirecting…</p>`
  : `<p>Workmate is a long-running service (a worker with a browser inside) and runs on Fly.io, Railway, or a server with Docker, not on Vercel.</p>
<p>To make this address redirect to the running service, set <code>WORKMATE_URL</code> in this Vercel project's environment variables and redeploy.</p>
<p>See the repository's README for deployment steps.</p>`;
fs.writeFileSync(
  `${out}/index.html`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workmate</title>${redirect}
<style>body{font:16px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c2230;background:#f5f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:28px 32px;max-width:520px}h1{font-size:20px;margin:0 0 12px}code{background:#f0f2f5;padding:1px 5px;border-radius:4px}</style></head>
<body><main><h1>Workmate</h1>${body}</main></body></html>
`,
);
console.log(`wrote ${out}/index.html${target ? ` (redirects to ${target})` : " (no WORKMATE_URL set)"}`);
