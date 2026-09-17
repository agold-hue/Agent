/* Workmate console: one file, no build step. Hash routes: #tasks, #task/<id>, #inbox, #schedules, #memory, #logins, #files, #settings */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtTime = (s) => { if (!s) return ""; const d = new Date(s); const now = new Date(); const sameDay = d.toDateString() === now.toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2);
const STATUS = { queued: "Queued", running: "Working", waiting_user: "Needs you", waiting_time: "Waiting", done: "Done", failed: "Failed", cancelled: "Cancelled" };

async function api(method, path, body, raw) {
  const opts = { method, headers: {} };
  if (body !== undefined && !raw) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (raw) { opts.body = raw.data; opts.headers["Content-Type"] = raw.type || "application/octet-stream"; opts.headers["X-File-Name"] = encodeURIComponent(raw.name); }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const get = (p) => api("GET", p), post = (p, b) => api("POST", p, b), patch = (p, b) => api("PATCH", p, b), del = (p) => api("DELETE", p);

const state = { me: null, timers: [], notifCount: 0 };
const app = $("#app");

function clearTimers() { for (const t of state.timers) clearInterval(t); state.timers = []; }
function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }

async function boot() {
  try { state.me = await get("/api/me"); } catch { state.me = null; }
  if (!state.me) return renderLogin();
  route();
  window.addEventListener("hashchange", route);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function renderLogin() {
  app.innerHTML = `<div class="login"><div class="brand">Workmate</div><p class="muted small">Your business's AI worker. Sign in with your email.</p>
  <div id="step1"><label>Email</label><input id="email" type="email" autocomplete="email"><label>Company (first sign-in only)</label><input id="company" placeholder="Acme LLC"><div style="margin-top:12px"><button class="primary" id="send">Send code</button></div><div class="err" id="err1"></div></div>
  <div id="step2" style="display:none"><label>Code from your email</label><input id="code" inputmode="numeric" autocomplete="one-time-code"><div style="margin-top:12px"><button class="primary" id="verify">Sign in</button></div><div class="err" id="err2"></div></div></div>`;
  $("#send").onclick = async () => {
    try { const r = await post("/api/auth/request-code", { email: $("#email").value }); $("#step2").style.display = ""; $("#code").focus(); if (r.dev) $("#err2").textContent = "Test deployment: use the shared DEV_LOGIN_CODE."; } catch (e) { $("#err1").textContent = e.message; }
  };
  $("#verify").onclick = async () => {
    try { await post("/api/auth/verify", { email: $("#email").value, code: $("#code").value, company: $("#company").value }); location.hash = "#tasks"; boot(); } catch (e) { $("#err2").textContent = e.message; }
  };
  $("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#verify").click(); });
}

function shell(active, content) {
  const nav = [["tasks", "Tasks"], ["inbox", "Inbox"], ["schedules", "Schedules"], ["memory", "Memory"], ["logins", "Logins"], ["files", "Files"], ["settings", "Settings"]];
  app.innerHTML = `<div class="layout"><aside class="side"><div class="brand">Workmate</div><nav>${nav.map(([k, l]) => `<a href="#${k}" class="${active === k ? "active" : ""}">${l}${k === "tasks" && state.notifCount ? ` <span class="badge">${state.notifCount}</span>` : ""}</a>`).join("")}</nav>
  <div class="small muted" style="margin-top:auto;padding:8px">${esc(state.me.org.name)}<br>${esc(state.me.user.email)}</div></aside><main id="main">${content}</main></div>`;
  if (!state.me.access) $("#main").insertAdjacentHTML("afterbegin", `<div class="notice">Your subscription is not active. <a href="#settings">Start it under Settings</a> to give the worker tasks.</div>`);
}

function route() {
  clearTimers();
  const h = location.hash.replace(/^#/, "") || "tasks";
  const [view, arg] = h.split("/");
  const views = { tasks: viewTasks, task: viewTask, inbox: viewInbox, schedules: viewSchedules, memory: viewMemory, logins: viewLogins, files: viewFiles, settings: viewSettings };
  (views[view] || viewTasks)(arg);
}

/* ---------------- Tasks ---------------- */
async function viewTasks() {
  shell("tasks", `<h1>Tasks</h1>
  <div class="card composer"><textarea id="instr" placeholder="What should the worker do? Give it everything it needs: names, order numbers, amounts, deadlines, who to contact. Example: 'Order 20 reams of letter paper from our Staples account, ship to the office, under $150.'"></textarea>
  <div class="row" style="margin-top:8px"><button class="primary" id="go">Give it to the worker</button><label style="margin:0"><input type="file" id="attach" multiple style="display:none"><button type="button" id="attachBtn">Attach files</button></label><span id="attachList" class="small muted"></span><span id="goErr" class="err"></span></div></div>
  <div id="needs"></div><h2>Recent</h2><div id="list"><p class="muted">Loading…</p></div>`);
  let attachments = [];
  $("#attachBtn").onclick = () => $("#attach").click();
  $("#attach").onchange = async (e) => { for (const f of e.target.files) { const r = await api("POST", "/api/files", undefined, { data: f, type: f.type, name: f.name }); attachments.push({ file_id: r.file.id, name: r.file.name }); } $("#attachList").textContent = attachments.map((a) => a.name).join(", "); };
  $("#go").onclick = async () => {
    const instruction = $("#instr").value.trim(); if (!instruction) return;
    $("#go").disabled = true;
    try { const r = await post("/api/tasks", { instruction, attachments }); location.hash = `#task/${r.task.id}`; } catch (e) { $("#goErr").textContent = e.message; $("#go").disabled = false; }
  };
  $("#instr").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#go").click(); });
  const load = async () => {
    const { tasks } = await get("/api/tasks?limit=80");
    const needs = tasks.filter((t) => t.status === "waiting_user");
    state.notifCount = needs.length;
    $("#needs").innerHTML = needs.length ? `<h2>Needs you</h2>${needs.map(taskCard).join("")}` : "";
    const rest = tasks.filter((t) => t.status !== "waiting_user");
    $("#list").innerHTML = rest.length ? rest.map(taskCard).join("") : `<p class="muted">No tasks yet. Describe one above.</p>`;
    for (const el of document.querySelectorAll("[data-task]")) el.onclick = () => (location.hash = `#task/${el.dataset.task}`);
  };
  await load();
  every(4000, load);
}

function taskCard(t) {
  const line = t.status === "waiting_user" && t.waiting ? (t.waiting.kind === "approval" ? `Approval: ${t.waiting.action}` : t.waiting.question) : t.result ? t.result : t.last_progress || t.instruction;
  return `<div class="card clickable" data-task="${t.id}"><div class="row" style="justify-content:space-between"><strong>${esc(t.title)}</strong><span><span class="pill ${t.status}">${STATUS[t.status]}${t.outcome && t.status === "done" && t.outcome !== "done" ? ` · ${t.outcome}` : ""}</span> <span class="small muted">${fmtTime(t.created_at)}</span></span></div>
  <div class="small" style="margin-top:6px;color:#3b4252;white-space:pre-wrap">${esc(String(line || "").slice(0, 260))}${String(line || "").length > 260 ? "…" : ""}</div>
  <div class="small muted" style="margin-top:6px">${esc(t.source)} · ${t.steps} steps · ${money(t.cost_cents)}</div></div>`;
}

async function viewTask(id) {
  shell("tasks", `<p><a href="#tasks">← Tasks</a></p><div id="task"><p class="muted">Loading…</p></div>`);
  let live = false, liveTimer = null, openTools = new Set();
  const render = async () => {
    let data; try { data = await get(`/api/tasks/${id}`); } catch (e) { $("#task").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const { task: t, events } = data;
    const active = ["running", "queued", "waiting_user", "waiting_time"].includes(t.status);
    const ask = t.status === "waiting_user" && t.waiting ? (t.waiting.kind === "approval"
      ? `<div class="ask"><strong>Approval needed</strong><div style="margin:6px 0">${esc(t.waiting.action)}${t.waiting.amount_usd != null ? ` <strong>($${t.waiting.amount_usd})</strong>` : ""}</div><pre>${esc(t.waiting.details || "")}</pre><div class="row"><input id="ansText" placeholder="Optional note"><button class="primary" id="approve">Approve</button><button class="danger" id="decline">Decline</button></div></div>`
      : `<div class="ask"><strong>Question</strong><div style="margin:6px 0;white-space:pre-wrap">${esc(t.waiting.question)}</div>${(t.waiting.options || []).length ? `<div class="chips">${t.waiting.options.map((o) => `<button data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}<div class="row" style="margin-top:8px"><input id="ansText" placeholder="Your answer"><button class="primary" id="answer">Send</button></div></div>`) : "";
    const evHtml = events.map((e) => {
      if (e.kind === "tool") return `<details class="ev tool" ${openTools.has(e.id) ? "open" : ""} data-ev="${e.id}"><summary><span class="t">${fmtTime(e.at)}</span>${esc(e.summary.split(" -> ")[0])}</summary>${esc(e.summary.split(" -> ").slice(1).join(" -> "))}</details>`;
      const label = { user: "You", step: "Worker", progress: "Progress", result: "Result", error: "Error", question: "Question", approval: "Approval", system: "System" }[e.kind] || e.kind;
      return `<div class="ev ${e.kind}"><span class="t">${fmtTime(e.at)} · ${label}</span>${esc(e.summary)}${e.data && e.data.attachments ? `<div class="small muted">Attached: ${e.data.attachments.map((a) => `<a href="/api/files/${a.file_id}/download">${esc(a.name)}</a>`).join(", ")}</div>` : ""}</div>`;
    }).join("");
    const scrolled = $("#events") ? $("#events").scrollTop : null;
    $("#task").innerHTML = `<h1>${esc(t.title)} <span class="pill ${t.status}">${STATUS[t.status]}</span></h1>
    <p class="small muted">${esc(t.source)} · created ${fmtTime(t.created_at)} · ${t.steps} steps · ${money(t.cost_cents)}${t.model ? ` · ${esc(t.model)}` : ""}${t.wake_at ? ` · resumes ${fmtTime(t.wake_at)}` : ""}</p>
    ${ask}
    <div class="toolbar">${active && t.status !== "done" ? `<button class="danger small" id="cancel">Stop task</button>` : ""}${!active ? `<button class="small" id="retry">Continue / try again</button>` : ""}${t.browser_used || t.status === "running" ? `<button class="small" id="liveBtn">${live ? "Hide browser" : "Watch browser"}</button>` : ""}</div>
    <div id="livePanel" style="display:${live ? "block" : "none"}"></div>
    <div class="events" id="events">${evHtml || '<p class="muted">Starting…</p>'}</div>
    <div class="card" style="margin-top:12px"><div class="row"><input id="msg" placeholder="${active ? "Send the worker a message (a code, an answer, a change of plan)" : "Follow up on this task"}"><button class="primary" id="sendMsg">Send</button></div></div>`;
    if (scrolled != null) $("#events").scrollTop = scrolled;
    for (const d of document.querySelectorAll("details[data-ev]")) d.addEventListener("toggle", () => (d.open ? openTools.add(d.dataset.ev) : openTools.delete(d.dataset.ev)));
    const answer = async (body) => { try { await post(`/api/tasks/${id}/answer`, body); await render(); } catch (e) { alert(e.message); } };
    if ($("#approve")) $("#approve").onclick = () => answer({ approved: true, text: $("#ansText").value });
    if ($("#decline")) $("#decline").onclick = () => answer({ approved: false, text: $("#ansText").value });
    if ($("#answer")) $("#answer").onclick = () => { if ($("#ansText").value.trim()) answer({ text: $("#ansText").value }); };
    for (const b of document.querySelectorAll("[data-opt]")) b.onclick = () => answer({ text: b.dataset.opt });
    if ($("#ansText")) $("#ansText").addEventListener("keydown", (e) => { if (e.key === "Enter") ($("#answer") || $("#approve")).click(); });
    $("#sendMsg").onclick = async () => { const text = $("#msg").value.trim(); if (!text) return; try { await post(`/api/tasks/${id}/message`, { text }); $("#msg").value = ""; await render(); } catch (e) { alert(e.message); } };
    $("#msg").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#sendMsg").click(); });
    if ($("#cancel")) $("#cancel").onclick = async () => { if (confirm("Stop this task?")) { await post(`/api/tasks/${id}/cancel`); await render(); } };
    if ($("#retry")) $("#retry").onclick = async () => { await post(`/api/tasks/${id}/retry`); await render(); };
    if ($("#liveBtn")) $("#liveBtn").onclick = () => { live = !live; if (live) mountLive($("#livePanel"), id); else { if (liveTimer) clearInterval(liveTimer); } render(); };
    if (live && !$("#livePanel").firstChild) mountLive($("#livePanel"), id);
  };
  await render();
  every(3000, render);
}

/* Live browser view: a JPEG every 700ms, clicks and keys forwarded. */
function mountLive(panel, taskId) {
  panel.innerHTML = `<div class="card"><div class="toolbar"><input id="lvUrl" placeholder="URL (manual browser only)"><button class="small" id="lvGo">Go</button><button class="small" id="lvBack">Back</button><input id="lvType" placeholder="Type here, Enter to send keys"><span class="small muted" id="lvInfo"></span></div>
  <div class="live"><img id="lvImg" alt="live browser"></div><p class="small muted">Click on the picture to click in the browser. Type in the box and press Enter to send text; Tab, Escape and arrows work too. Sign in to a site here once and the worker stays signed in.</p></div>`;
  const img = $("#lvImg", panel);
  const refresh = async () => {
    const r = await fetch(`/api/browser/${taskId}/frame?t=${Date.now()}`);
    if (!r.ok) { $("#lvInfo", panel).textContent = "no open tab"; return; }
    $("#lvInfo", panel).textContent = decodeURIComponent(r.headers.get("X-Page-Url") || "");
    const blob = await r.blob(); const url = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(url); img.src = url;
  };
  refresh();
  every(700, refresh);
  const send = (ev) => post(`/api/browser/${taskId}/input`, ev).catch(() => {});
  img.onclick = (e) => { const r = img.getBoundingClientRect(); const sx = img.naturalWidth / r.width, sy = img.naturalHeight / r.height; send({ type: "click", x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) }); };
  img.onwheel = (e) => { e.preventDefault(); send({ type: "scroll", dy: Math.sign(e.deltaY) * 400, x: 400, y: 300 }); };
  $("#lvType", panel).onkeydown = (e) => {
    if (e.key === "Enter") { const v = e.target.value; e.target.value = ""; if (v) send({ type: "type", text: v }); else send({ type: "key", key: "Enter" }); e.preventDefault(); }
    else if (["Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace"].includes(e.key) && !e.target.value) { send({ type: "key", key: e.key }); e.preventDefault(); }
  };
  $("#lvGo", panel).onclick = () => { const url = $("#lvUrl", panel).value.trim(); if (taskId === "manual") post("/api/browser/manual/open", { url }); else send({ type: "navigate", url }); };
  $("#lvBack", panel).onclick = () => send({ type: "back" });
}

/* ---------------- Inbox ---------------- */
async function viewInbox() {
  shell("inbox", `<h1>Inbox</h1><p class="muted small">Connect the mailbox the worker should watch (IMAP) and send from (SMTP). New mail is read every minute; anything that needs action becomes a task.</p>
  <div id="accounts"></div>
  <details class="card"><summary>Connect a mailbox</summary><div class="grid2">
  <div><label>Address</label><input id="mAddr" placeholder="ops@yourcompany.com"><label>Sender name</label><input id="mFrom" placeholder="Acme Operations"><label>Label</label><input id="mLabel" placeholder="Ops inbox"></div>
  <div><label>IMAP host</label><input id="mImapHost" placeholder="imap.gmail.com"><label>IMAP port</label><input id="mImapPort" value="993"><label>IMAP user</label><input id="mImapUser" placeholder="(defaults to the address)"><label>IMAP password / app password</label><input id="mImapPass" type="password"></div>
  <div><label>SMTP host</label><input id="mSmtpHost" placeholder="smtp.gmail.com"><label>SMTP port</label><input id="mSmtpPort" value="587"><label>SMTP user</label><input id="mSmtpUser" placeholder="(defaults to the address)"><label>SMTP password</label><input id="mSmtpPass" type="password"></div></div>
  <p class="small muted">Gmail and Google Workspace: turn on 2-step verification, create an App Password, use imap.gmail.com:993 and smtp.gmail.com:587. Microsoft 365: outlook.office365.com:993 and smtp.office365.com:587 with SMTP AUTH enabled.</p>
  <button class="primary" id="mSave">Save mailbox</button><span class="err" id="mErr"></span></details>
  <h2>Recent mail</h2><div id="mail"></div>`);
  const load = async () => {
    const { accounts } = await get("/api/mail/accounts");
    $("#accounts").innerHTML = accounts.length ? accounts.map((a) => `<div class="card"><div class="row" style="justify-content:space-between"><div><strong>${esc(a.label)}</strong> <span class="muted small">${esc(a.address)}</span><div class="small muted">${a.has_imap ? "reads mail" : "no IMAP"} · ${a.has_smtp ? "sends mail" : "no SMTP"} · ${a.last_polled_at ? `checked ${fmtTime(a.last_polled_at)}` : "not checked yet"}${a.last_error ? ` · <span class="err">${esc(a.last_error)}</span>` : ""}</div></div><div class="row"><button class="small" data-test="${a.id}">Test now</button><button class="small danger" data-del="${a.id}">Remove</button></div></div></div>`).join("") : `<p class="muted">No mailbox connected yet.</p>`;
    for (const b of document.querySelectorAll("[data-test]")) b.onclick = async () => { b.disabled = true; try { const r = await post(`/api/mail/accounts/${b.dataset.test}/test`); alert(r.ok ? `Connected. Fetched ${r.fetched} new message(s).` : `Failed: ${r.error}`); } catch (e) { alert(e.message); } b.disabled = false; load(); };
    for (const b of document.querySelectorAll("[data-del]")) b.onclick = async () => { if (confirm("Remove this mailbox?")) { await del(`/api/mail/accounts/${b.dataset.del}`); load(); } };
    const { messages } = await get("/api/mail/messages?limit=40");
    $("#mail").innerHTML = messages.length ? `<table><tr><th>When</th><th>Dir</th><th>From / To</th><th>Subject</th><th>Triage</th></tr>${messages.map((m) => `<tr><td>${fmtTime(m.received_at)}</td><td>${m.direction}</td><td>${esc(m.direction === "in" ? m.from_address : m.to_address)}</td><td>${esc(m.subject || "")}</td><td>${m.triage ? esc(m.triage.category) : ""}${m.task_id ? ` · <a href="#task/${m.task_id}">task</a>` : ""}</td></tr>`).join("")}</table>` : `<p class="muted">No mail yet.</p>`;
  };
  $("#mSave").onclick = async () => {
    try { await post("/api/mail/accounts", { address: $("#mAddr").value, from_name: $("#mFrom").value, label: $("#mLabel").value, imap_host: $("#mImapHost").value, imap_port: $("#mImapPort").value, imap_user: $("#mImapUser").value, imap_pass: $("#mImapPass").value, smtp_host: $("#mSmtpHost").value, smtp_port: $("#mSmtpPort").value, smtp_user: $("#mSmtpUser").value, smtp_pass: $("#mSmtpPass").value }); load(); } catch (e) { $("#mErr").textContent = e.message; }
  };
  await load();
  every(15000, load);
}

/* ---------------- Schedules ---------------- */
async function viewSchedules() {
  shell("schedules", `<h1>Schedules</h1><p class="muted small">Recurring work in the company's time zone (${esc(state.me.org.timezone)}). Cron: minute hour day month weekday. Examples: <code>0 8 * * 1-5</code> weekdays 8:00; <code>0 9 * * 1</code> Mondays 9:00; <code>0 17 1 * *</code> the 1st at 17:00.</p>
  <div class="card"><label>Title</label><input id="sTitle" placeholder="Morning inbox sweep"><label>Cron</label><input id="sCron" placeholder="0 8 * * 1-5"><label>Instructions</label><textarea id="sInstr" placeholder="Go through unread mail from the last 24 hours, reply to anything routine, list what needs a decision."></textarea><div class="row" style="margin-top:8px"><button class="primary" id="sAdd">Add schedule</button><span class="err" id="sErr"></span></div></div><div id="list"></div>`);
  const load = async () => {
    const { schedules } = await get("/api/schedules");
    $("#list").innerHTML = schedules.length ? schedules.map((s) => `<div class="card"><div class="row" style="justify-content:space-between"><div><strong>${esc(s.title)}</strong> <code>${esc(s.cron)}</code> ${s.active ? "" : '<span class="pill">paused</span>'}<div class="small muted">next ${s.next_run_at ? fmtTime(s.next_run_at) : "—"}${s.last_run_at ? ` · last ${fmtTime(s.last_run_at)}` : ""}</div><div class="small" style="white-space:pre-wrap;margin-top:4px">${esc(s.instruction)}</div></div><div class="row"><button class="small" data-run="${s.id}">Run now</button><button class="small" data-toggle="${s.id}" data-active="${s.active}">${s.active ? "Pause" : "Resume"}</button><button class="small danger" data-del="${s.id}">Delete</button></div></div></div>`).join("") : `<p class="muted">No schedules yet.</p>`;
    for (const b of document.querySelectorAll("[data-run]")) b.onclick = async () => { const r = await post(`/api/schedules/${b.dataset.run}/run`); location.hash = `#task/${r.task.id}`; };
    for (const b of document.querySelectorAll("[data-toggle]")) b.onclick = async () => { await patch(`/api/schedules/${b.dataset.toggle}`, { active: b.dataset.active !== "true" }); load(); };
    for (const b of document.querySelectorAll("[data-del]")) b.onclick = async () => { if (confirm("Delete this schedule?")) { await del(`/api/schedules/${b.dataset.del}`); load(); } };
  };
  $("#sAdd").onclick = async () => { try { await post("/api/schedules", { title: $("#sTitle").value, cron: $("#sCron").value, instruction: $("#sInstr").value }); $("#sTitle").value = $("#sCron").value = $("#sInstr").value = ""; load(); } catch (e) { $("#sErr").textContent = e.message; } };
  await load();
}

/* ---------------- Memory ---------------- */
async function viewMemory() {
  shell("memory", `<h1>Memory</h1><p class="muted small">What the worker knows about the company: facts and rules, how sites work, contacts, procedures, and a line per finished task. Edit anything.</p>
  <div class="card"><div class="row"><select id="mKind" style="width:auto"><option value="fact">fact</option><option value="site">site</option><option value="contact">contact</option><option value="procedure">procedure</option></select><input id="mKey" placeholder="key, e.g. shipping address / amazon.com / Jane at Acme"></div><textarea id="mContent" placeholder="The note"></textarea><div class="row" style="margin-top:8px"><button class="primary" id="mSave">Save</button></div></div>
  <div class="row"><label style="margin:0">Show</label><select id="mFilter" style="width:auto"><option value="">all</option><option>fact</option><option>site</option><option>contact</option><option>procedure</option><option>history</option></select></div><div id="list"></div>`);
  const load = async () => {
    const kind = $("#mFilter").value;
    const { memories } = await get(`/api/memory${kind ? `?kind=${kind}` : ""}`);
    $("#list").innerHTML = memories.length ? memories.map((m) => `<div class="card"><div class="row" style="justify-content:space-between"><div><span class="pill">${esc(m.kind)}</span> <strong>${esc(m.key)}</strong> <span class="small muted">${fmtTime(m.updated_at)}</span></div><div class="row"><button class="small" data-edit="${m.id}">Edit</button><button class="small danger" data-del="${m.id}">Delete</button></div></div><pre>${esc(m.content)}</pre></div>`).join("") : `<p class="muted">Nothing here yet.</p>`;
    for (const b of document.querySelectorAll("[data-edit]")) b.onclick = () => { const m = memories.find((x) => x.id === b.dataset.edit); $("#mKind").value = m.kind === "history" ? "fact" : m.kind; $("#mKey").value = m.key; $("#mContent").value = m.content; window.scrollTo(0, 0); };
    for (const b of document.querySelectorAll("[data-del]")) b.onclick = async () => { await del(`/api/memory/${b.dataset.del}`); load(); };
  };
  $("#mSave").onclick = async () => { try { await post("/api/memory", { kind: $("#mKind").value, key: $("#mKey").value, content: $("#mContent").value }); $("#mKey").value = $("#mContent").value = ""; load(); } catch (e) { alert(e.message); } };
  $("#mFilter").onchange = load;
  await load();
}

/* ---------------- Logins ---------------- */
async function viewLogins() {
  shell("logins", `<h1>Logins</h1><p class="muted small">Site logins the worker may use. Passwords are encrypted; the worker never sees them, it only asks the host to type them into the sign-in form. For sites with codes or bot checks, sign in once yourself in the live browser below: the session sticks.</p>
  <div class="card"><div class="grid2"><div><label>Site</label><input id="lDomain" placeholder="staples.com"><label>Username / email</label><input id="lUser"></div><div><label>Password</label><input id="lPass" type="password"><label>Authenticator secret (optional, base32)</label><input id="lTotp"></div></div><label>Notes for the worker</label><input id="lNotes" placeholder="Use the business account; 2FA goes to Sam's phone"><div class="row" style="margin-top:8px"><button class="primary" id="lSave">Save login</button><span class="err" id="lErr"></span></div></div>
  <div id="list"></div>
  <h2>Sign in yourself</h2><p class="small muted">Open a site in the company's browser and sign in by hand. Cookies stay in the profile for every later task.</p><div class="row" style="margin-bottom:8px"><input id="manUrl" placeholder="https://accounts.example.com/login" style="flex:1"><button class="primary" id="manOpen">Open</button><button id="manClose">Close</button></div><div id="manual"></div>`);
  const load = async () => {
    const { logins } = await get("/api/logins");
    $("#list").innerHTML = logins.length ? `<table><tr><th>Site</th><th>Username</th><th>2FA</th><th>Notes</th><th></th></tr>${logins.map((l) => `<tr><td>${esc(l.domain)}</td><td>${esc(l.username)}</td><td>${l.has_totp ? "authenticator" : ""}</td><td>${esc(l.notes || "")}</td><td><button class="small danger" data-del="${l.id}">Remove</button></td></tr>`).join("")}</table>` : `<p class="muted">No logins saved.</p>`;
    for (const b of document.querySelectorAll("[data-del]")) b.onclick = async () => { await del(`/api/logins/${b.dataset.del}`); load(); };
  };
  $("#lSave").onclick = async () => { try { await post("/api/logins", { domain: $("#lDomain").value, username: $("#lUser").value, password: $("#lPass").value, totp_secret: $("#lTotp").value, notes: $("#lNotes").value }); $("#lDomain").value = $("#lUser").value = $("#lPass").value = $("#lTotp").value = $("#lNotes").value = ""; load(); } catch (e) { $("#lErr").textContent = e.message; } };
  $("#manOpen").onclick = async () => { await post("/api/browser/manual/open", { url: $("#manUrl").value }); if (!$("#manual").firstChild) mountLive($("#manual"), "manual"); };
  $("#manClose").onclick = async () => { await post("/api/browser/manual/close"); clearTimers(); $("#manual").innerHTML = ""; };
  await load();
}

/* ---------------- Files ---------------- */
async function viewFiles() {
  shell("files", `<h1>Files</h1><div class="row" style="margin-bottom:10px"><input type="file" id="up" multiple style="display:none"><button class="primary" id="upBtn">Upload</button><span class="small muted">PDFs, images, spreadsheets, documents the worker may need or produced.</span></div><div id="list"></div>`);
  const load = async () => {
    const { files } = await get("/api/files");
    $("#list").innerHTML = files.length ? `<table><tr><th>Name</th><th>Type</th><th>Size</th><th>When</th><th></th></tr>${files.map((f) => `<tr><td><a href="/api/files/${f.id}/download">${esc(f.name)}</a></td><td class="small muted">${esc(f.mime)}</td><td class="small">${(f.bytes / 1024).toFixed(0)} KB</td><td class="small">${fmtTime(f.created_at)}</td><td><button class="small danger" data-del="${f.id}">Delete</button></td></tr>`).join("")}</table>` : `<p class="muted">No files yet.</p>`;
    for (const b of document.querySelectorAll("[data-del]")) b.onclick = async () => { await del(`/api/files/${b.dataset.del}`); load(); };
  };
  $("#upBtn").onclick = () => $("#up").click();
  $("#up").onchange = async (e) => { for (const f of e.target.files) await api("POST", "/api/files", undefined, { data: f, type: f.type, name: f.name }); load(); };
  await load();
}

/* ---------------- Settings ---------------- */
async function viewSettings() {
  const me = await get("/api/me"); state.me = me;
  const o = me.org, s = o.settings || {};
  const kinds = ["purchase", "payment", "cancel", "agreement", "account", "other"];
  shell("settings", `<h1>Settings</h1>
  <div class="card"><h2 style="margin-top:0">Company</h2><div class="grid2"><div><label>Name</label><input id="oName" value="${esc(o.name)}"></div><div><label>Time zone</label><input id="oTz" value="${esc(o.timezone)}" placeholder="America/New_York"></div></div>
  <label>About the company (the worker reads this on every task)</label><textarea id="oProfile" style="min-height:160px" placeholder="What we do, addresses, phone, tax id if needed for forms, who is who, preferred vendors, payment methods on file (never card numbers), standing rules like 'always ship to the warehouse' or 'never agree to auto-renewal'.">${esc(s.profile || "")}</textarea>
  <label>Standing instructions for incoming mail</label><textarea id="oInbox" placeholder="Answer customer questions about orders and hours; forward legal or press requests to me; ignore newsletters; pay vendor invoices under $500 from approved vendors.">${esc(s.inbox_instructions || "")}</textarea>
  <label>Email signature</label><input id="oSig" value="${esc(s.signature || "")}" placeholder="— ${esc(o.name)} operations"></div>
  <div class="card"><h2 style="margin-top:0">Approvals</h2><p class="small muted">The worker asks before consequential steps. Pre-approve kinds here and set a ceiling; anything above the ceiling, or not listed, waits for you.</p>
  <div class="chips">${kinds.map((k) => `<label style="display:inline-block;margin-right:14px"><input type="checkbox" data-kind="${k}" ${(s.auto_approve_kinds || []).includes(k) ? "checked" : ""}> ${k}</label>`).join("")}</div>
  <div class="grid2"><div><label>Money ceiling for pre-approved kinds (USD)</label><input id="oCeil" type="number" value="${esc(s.auto_approve_under_usd ?? 0)}"></div><div><label>Emails to outsiders</label><select id="oMail"><option value="0" ${!s.auto_send_email ? "selected" : ""}>Wait for my approval</option><option value="1" ${s.auto_send_email ? "selected" : ""}>Send without asking</option></select></div></div></div>
  <div class="card"><h2 style="margin-top:0">Notifications</h2><div class="grid2"><div><label>Email me when a task needs me or finishes</label><select id="oNotify"><option value="1" ${s.notify_email !== false ? "selected" : ""}>Yes</option><option value="0" ${s.notify_email === false ? "selected" : ""}>No</option></select></div><div><label>Quiet hours (no non-urgent mail), e.g. 22-7</label><input id="oQuiet" value="${esc(s.quiet_hours || "")}"></div></div>
  ${me.features.push_key ? `<div style="margin-top:10px"><button id="pushBtn">Enable push notifications on this device</button></div>` : ""}</div>
  <div class="row"><button class="primary" id="save">Save settings</button><span id="saveMsg" class="small muted"></span></div>
  <div class="card" style="margin-top:16px"><h2 style="margin-top:0">People</h2><div id="members"></div><div class="row"><input id="memEmail" placeholder="colleague@company.com" style="flex:1"><button id="memAdd">Add</button></div></div>
  <div class="card"><h2 style="margin-top:0">Plan and usage</h2><p>This month: <strong>${money(me.usage_cents)}</strong> of model usage${me.cap_usd ? ` (cap $${me.cap_usd})` : ""}. Status: <strong>${esc(o.subscription_status)}</strong>${o.current_period_end ? ` until ${fmtTime(o.current_period_end)}` : ""}. Model: ${esc(me.features.model)}.</p>
  ${me.features.stripe ? `<div class="row">${me.access ? `<button id="portal">Manage subscription</button>` : `<button class="primary" id="checkout">Start subscription</button>`}</div>` : `<p class="small muted">Billing is not configured on this server; access is open.</p>`}</div>
  <p><button id="logout">Sign out</button></p>`);
  const loadMembers = async () => { const { members } = await get("/api/members"); $("#members").innerHTML = `<table>${members.map((m) => `<tr><td>${esc(m.email)}</td><td class="small muted">${esc(m.role)}</td><td>${m.id !== me.user.id && me.user.role === "owner" ? `<button class="small danger" data-del="${m.id}">Remove</button>` : ""}</td></tr>`).join("")}</table>`; for (const b of document.querySelectorAll("[data-del]")) b.onclick = async () => { await del(`/api/members/${b.dataset.del}`); loadMembers(); }; };
  await loadMembers();
  $("#memAdd").onclick = async () => { try { await post("/api/members", { email: $("#memEmail").value }); $("#memEmail").value = ""; loadMembers(); } catch (e) { alert(e.message); } };
  $("#save").onclick = async () => {
    const settings = { profile: $("#oProfile").value, inbox_instructions: $("#oInbox").value, signature: $("#oSig").value, auto_approve_kinds: [...document.querySelectorAll("[data-kind]")].filter((c) => c.checked).map((c) => c.dataset.kind), auto_approve_under_usd: Number($("#oCeil").value || 0), auto_send_email: $("#oMail").value === "1", notify_email: $("#oNotify").value === "1", quiet_hours: $("#oQuiet").value };
    try { await patch("/api/org", { name: $("#oName").value, timezone: $("#oTz").value, settings }); $("#saveMsg").textContent = "Saved."; setTimeout(() => ($("#saveMsg").textContent = ""), 2000); } catch (e) { alert(e.message); }
  };
  if ($("#pushBtn")) $("#pushBtn").onclick = async () => {
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(me.features.push_key) }); await post("/api/push/subscribe", { subscription: sub.toJSON() }); alert("Push enabled on this device."); } catch (e) { alert(e.message); }
  };
  if ($("#checkout")) $("#checkout").onclick = async () => { const r = await post("/api/billing/checkout"); location.href = r.url; };
  if ($("#portal")) $("#portal").onclick = async () => { const r = await post("/api/billing/portal"); location.href = r.url; };
  $("#logout").onclick = async () => { await post("/api/auth/logout"); location.hash = ""; boot(); };
}

function urlB64(s) { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }

boot();
