const $ = (id) => document.getElementById(id);
chrome.storage.local.get(["server", "token"]).then((s) => {
  $("server").value = s.server || "";
  $("token").value = s.token || "";
});
$("save").onclick = async () => {
  const server = $("server").value.trim().replace(/\/$/, "");
  const token = $("token").value.trim();
  if (!/^https:\/\//.test(server)) return ($("msg").textContent = "The app address must start with https://");
  if (!/^rl_[a-zA-Z0-9]{20,}$/.test(token)) return ($("msg").textContent = "That does not look like a relay token (rl_…).");
  await chrome.storage.local.set({ server, token });
  try {
    const res = await fetch(`${server}/api/relay?action=next&token=${encodeURIComponent(token)}`);
    $("msg").textContent = res.ok ? "Connected. Leave this browser open; your secretary will use a tab of its own when it needs to." : `The server rejected the token (${res.status}). Create a new one in the app.`;
    $("msg").className = res.ok ? "ok" : "hint";
  } catch (err) {
    $("msg").textContent = `Could not reach ${server}: ${err.message}`;
  }
};
