const MAX_LEN = 1800;

export function createZaloClient(token) {
  const base = `https://bot-api.zaloplatforms.com/bot${token}`;

  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function sendMessage(chatId, text) {
    for (const part of splitText(text)) {
      // Noi dung da duoc format.js escape/ghep markup -> bat parse_mode markdown.
      const r = await call("sendMessage", { chat_id: chatId, text: part, parse_mode: "markdown" });
      if (r && r.ok === false) throw new Error(`Zalo sendMessage loi: ${JSON.stringify(r)}`);
    }
  }

  return {
    sendMessage,
    // Zalo getUpdates tra 408 (ok:false) khi het timeout ma khong co tin moi - binh thuong.
    getUpdates: (timeout = 25) => call("getUpdates", { timeout }),
    getMe: () => call("getMe", {}),
  };
}

export function splitText(text) {
  if (text.length <= MAX_LEN) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
