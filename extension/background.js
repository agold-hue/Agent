// The relay's service worker: polls the server for a command, runs it in a tab of its own, posts
// the result. Idle polling backs off to every 5 seconds; with work in flight it polls every second.
// The server never sees a password: typing goes into the page here, and the snapshot never includes
// a password field's value.

const state = { tabId: null, busy: false, idleTicks: 0 };

async function settings() {
  const s = await chrome.storage.local.get(["server", "token"]);
  return { server: (s.server || "").replace(/\/$/, ""), token: s.token || "" };
}

async function ownTab() {
  if (state.tabId != null) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab) return tab;
    } catch {
      state.tabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  state.tabId = tab.id;
  return tab;
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, 600);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

// Runs inside the page. Numbers every visible control and stamps data-agent-ref, like the hosted browser does.
function pageSnapshot(max) {
  const isVisible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
  const lines = [];
  const seen = new Map();
  let n = 0;
  for (const el of els) {
    if (n >= max) break;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input:" + (el.type || "text") : tag);
    const label = String(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || (tag === "input" && el.type !== "password" ? el.value : "") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const key = role + "|" + label.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > 3) continue;
    n++;
    el.setAttribute("data-agent-ref", String(n));
    const extra = [];
    if (tag === "input" && el.value && el.type !== "password") extra.push('value="' + String(el.value).slice(0, 40) + '"');
    if (el.checked) extra.push("checked");
    if (el.disabled) extra.push("disabled");
    if (tag === "a" && el.href && !el.href.startsWith("javascript:")) { try { const u = new URL(el.href); extra.push((u.origin === location.origin ? u.pathname + u.search : el.href).slice(0, 60)); } catch {} }
    lines.push(("[" + n + "] " + role + ' "' + label + '" ' + extra.join(" ")).trim());
  }
  for (const [k, c] of seen) if (c > 3) lines.push("(+" + (c - 3) + ' more ' + k.split("|")[0] + ' "' + k.split("|")[1] + '")');
  const headings = Array.from(document.querySelectorAll("h1, h2")).filter(isVisible).slice(0, 12).map((h) => "# " + h.innerText.trim().replace(/\s+/g, " ").slice(0, 100));
  return { title: document.title, url: location.href, snapshot: [document.title, location.href, ...headings, ...lines].join("\n") + (els.length > max ? "\n... " + (els.length - max) + " more elements" : "") };
}

function pageText() {
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000) };
}

function pageFind(q) {
  const needle = String(q).toLowerCase().trim();
  const out = [];
  for (const el of Array.from(document.querySelectorAll("[data-agent-ref]"))) {
    const label = String(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || "").replace(/\s+/g, " ").trim();
    if (label.toLowerCase().includes(needle)) out.push("[" + el.getAttribute("data-agent-ref") + "] " + el.tagName.toLowerCase() + ' "' + label.slice(0, 80) + '"' + (label.toLowerCase() === needle ? " (exact)" : ""));
    if (out.length >= 10) break;
  }
  return { url: location.href, text: out.join("\n") || 'no visible element matching "' + q + '"' };
}

function pageAct(ref, text, kind, enter) {
  let el = ref ? document.querySelector('[data-agent-ref="' + String(ref).replace(/\D/g, "") + '"]') : null;
  if (!el && text) {
    const needle = String(text).toLowerCase().trim();
    const all = Array.from(document.querySelectorAll("[data-agent-ref]"));
    const labelOf = (e) => String(e.getAttribute("aria-label") || (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute("placeholder") || e.getAttribute("title") || e.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
    el = all.find((e) => labelOf(e) === needle) || all.find((e) => labelOf(e).includes(needle)) || null;
  }
  if (!el) return { error: "no element for " + (ref ? "[" + ref + "]" : '"' + text + '"') + "; take a snapshot first" };
  el.scrollIntoView({ block: "center" });
  if (kind === "click") {
    el.click();
    return { ok: true };
  }
  el.focus();
  if (el.isContentEditable) el.textContent = text;
  else {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (enter) {
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    const form = el.form;
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  }
  return { ok: true };
}

async function exec(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
  return r && r.result ? r.result : {};
}

async function run(command) {
  const tab = await ownTab();
  const id = tab.id;
  try {
    if (command.kind === "goto") {
      await chrome.tabs.update(id, { url: command.url, active: false });
      await waitForLoad(id);
      return await exec(id, pageSnapshot, [140]);
    }
    if (command.kind === "back") {
      await chrome.tabs.goBack(id);
      await waitForLoad(id, 15000);
      return await exec(id, pageSnapshot, [140]);
    }
    if (command.kind === "snapshot") return await exec(id, pageSnapshot, [250]);
    if (command.kind === "text") return await exec(id, pageText, []);
    if (command.kind === "find") {
      await exec(id, pageSnapshot, [250]);
      return await exec(id, pageFind, [command.text || ""]);
    }
    if (command.kind === "click" || command.kind === "type") {
      if (!command.ref) await exec(id, pageSnapshot, [250]);
      const r = await exec(id, pageAct, [command.ref || "", command.text || "", command.kind, !!command.enter]);
      if (r.error) return r;
      await new Promise((res) => setTimeout(res, command.kind === "click" || command.enter ? 1500 : 600));
      const snap = await exec(id, pageSnapshot, [140]);
      return { ...snap, snapshot: (command.kind === "click" ? "clicked" : "typed") + " -> " + snap.url + "\n\n" + snap.snapshot };
    }
    return { error: "unknown command " + command.kind };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

async function tick() {
  if (state.busy) return;
  const { server, token } = await settings();
  if (!server || !token) return;
  state.busy = true;
  try {
    const tab = state.tabId != null ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
    const url = tab && tab.url ? "&url=" + encodeURIComponent(tab.url) : "";
    const res = await fetch(server + "/api/relay?action=next&token=" + encodeURIComponent(token) + url);
    if (!res.ok) throw new Error("server " + res.status);
    const job = await res.json();
    if (!job || !job.id) {
      state.idleTicks++;
      return;
    }
    state.idleTicks = 0;
    const result = await run(job.command || {});
    await fetch(server + "/api/relay?action=result&token=" + encodeURIComponent(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: job.id, result }) });
  } catch (err) {
    console.warn("[relay]", err);
    state.idleTicks++;
  } finally {
    state.busy = false;
  }
}

// Alarms keep the worker alive at 1-minute granularity; inside a wake-up we poll faster for a while.
chrome.alarms.create("relay", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  for (let i = 0; i < 40; i++) {
    await tick();
    await new Promise((r) => setTimeout(r, state.idleTicks > 6 ? 5000 : 1200));
  }
});
chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
tick();
