const SERVER = "http://127.0.0.1:3000";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith("http")) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
});

chrome.runtime.onMessage.addListener((msg: { type: string; body: unknown }, _sender, reply) => {
  if (msg.type !== "plan") return false;
  fetch(`${SERVER}/api/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg.body) })
    .then(async (r) => reply({ ok: r.ok, json: await r.json() }))
    .catch((e: Error) => reply({ ok: false, json: { error: `Can't reach the S'mile server at ${SERVER} — is it running? (${e.message})` } }));
  return true;
});
