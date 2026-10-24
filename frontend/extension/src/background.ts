const SERVER = "https://calhacks-beta.vercel.app";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith("http")) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "open" });
  } catch {}
});

chrome.runtime.onMessage.addListener((message: { type: string; body: unknown }, _sender, reply) => {
  if (message.type !== "route") return false;
  fetch(`${SERVER}/api/extension/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message.body) })
    .then(async (response) => reply({ ok: response.ok, json: await response.json() }))
    .catch((error: Error) => reply({ ok: false, json: { error: `S’mile’s routing service is unavailable. ${error.message}` } }));
  return true;
});
