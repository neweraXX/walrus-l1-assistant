import { bootstrap } from "./bootstrap.js";
import { createZaloClient } from "./zalo.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { cfg, assistant, knowledge } = await bootstrap({ needZalo: true });
const zalo = createZaloClient(cfg.zaloToken);

let botName = "";
try {
  const me = await zalo.getMe();
  botName = me?.result?.display_name || "";
} catch (err) {
  console.warn("Khong lay duoc getMe:", err.message);
}

const NAME_TRIGGER = /^\s*walrus\b[\s,:!.]*/i;

// Xac dinh tin nhan co phai "goi bot" khong, va boc phan noi dung ra.
// - @tag bot: luon nhan.
// - "walrus <cau hoi>": nhan (neu Zalo co day tin khong-tag toi bot).
// - Trong chat 1-1 (khong phai group zgr-): nhan het.
// Tra ve null neu khong phai goi bot (bo qua, khong ton LLM).
function resolveText(rawText, chatId) {
  const t = rawText.trim();
  const tagged = botName && t.toLowerCase().startsWith(`@${botName}`.toLowerCase());
  if (tagged) return t.slice(botName.length + 1).trim();
  if (/^@\S+/.test(t) && new RegExp(`@${botName}`, "i").test(t)) return t.replace(/^@\S+\s*/, "").trim();
  // Tag bot o GIUA/CUOI cau (vd "Nguoi tag minh la sep thi sao nhi @Bot Walrus") -> van nhan.
  if (botName) {
    const at = new RegExp(`@${botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
    if (at.test(t)) return t.replace(at, " ").replace(/\s+/g, " ").trim();
  }
  if (NAME_TRIGGER.test(t)) return t.replace(NAME_TRIGGER, "").trim();
  if (!chatId.startsWith("zgr-")) return t; // chat 1-1: khong can goi ten
  return null; // trong group ma khong goi bot -> bo qua
}

const JIRA_TOOL_URL = process.env.JIRA_TOOL_URL || "http://127.0.0.1:8788/jira-tool";
async function runJiraTool({ tool, params }, { userId, userName }) {
  try {
    const res = await fetch(JIRA_TOOL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, params, userId, userName }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.status);
    return data.replies || [];
  } catch (err) {
    console.error("[jira-tool] loi:", err.message);
    return ["Mình tra Jira đang lỗi, thử lại sau ít phút nhé."];
  }
}

async function onMessage(message) {
  const chatId = message?.chat?.id;
  // Anh (thu nghiem): Zalo gui message_type CHAT_PHOTO + photo_url (+ caption).
  const isPhoto = message?.message_type === "CHAT_PHOTO" && !!message.photo_url;
  if (!chatId || (!message.text && !isPhoto)) return;

  // Nhan tin RIENG (chat 1-1): chi nguoi trong ALLOWED_DM_USER_IDS - bot nay tra ca kho
  // chuyen sau (kbpriv) nen KHONG mo cho nguoi la. Group: van theo ALLOWED_CHAT_IDS.
  const isGroup = chatId.startsWith("zgr-");
  const fromId = message.from?.id || "";
  if (!isGroup) {
    if (!cfg.allowedDmUserIds.includes(fromId) && !cfg.allowedDmUserIds.includes(chatId)) {
      console.log(`[zalo] bo qua tin rieng tu nguoi khong nam trong ALLOWED_DM_USER_IDS: from=${fromId} chat=${chatId}`);
      return;
    }
  } else if (cfg.allowedChatIds.length && !cfg.allowedChatIds.includes(chatId)) {
    console.log(`[zalo] bo qua chat khong nam trong ALLOWED_CHAT_IDS: ${chatId}`);
    return;
  }

  const userId = message.from?.id || chatId;
  const userName = message.from?.display_name || "ai do";
  // DOC ANH: tam CHI tin rieng (da qua kiem tra ALLOWED_DM_USER_IDS o tren), chua bat cho group.
  if (isPhoto) {
    if (isGroup) return;
    console.log(`[zalo] chat=${chatId} from=${userName} gui ANH (chu thich: ${message.caption || "-"})`);
    try {
      const replies = await assistant.handleImage({ chatId, userId, userName, imageUrl: message.photo_url, caption: String(message.caption || "") });
      for (const r of replies) if (typeof r === "string") await zalo.sendMessage(chatId, r);
    } catch (err) {
      console.error("[image] loi:", err);
      await zalo.sendMessage(chatId, `Bot gặp lỗi khi đọc ảnh: ${err.message}`).catch(() => {});
    }
    return;
  }
  const text = resolveText(message.text, chatId);
  console.log(`[zalo] chat=${chatId} from=${userName}(${userId}) goiBot=${text !== null}: ${message.text}`);
  if (text === null || !text) return;

  try {
    let replies = await assistant.handle({ chatId, userId, userName, text });
    // Cau hoi ticket Jira (chi tin rieng cua Ha) -> goi cong noi bo cua bot production chay cong cu co
    // dinh, chi doc. Token Jira khong nam o bot nay.
    if (replies[0]?.jira) replies = await runJiraTool(replies[0].jira, { userId, userName });
    for (const r of replies) if (typeof r === "string") await zalo.sendMessage(chatId, r);
    // Tin bao them sau khi kiem chung tren chain (vd "Da luu chac chan") - khong bat cho.
    replies.followUp?.then((msg) => msg && zalo.sendMessage(chatId, msg)).catch((err) => console.error("[proof] khong gui duoc:", err.message));
  } catch (err) {
    console.error("[assistant] loi:", err);
    await zalo.sendMessage(chatId, `Bot gặp lỗi khi xử lý: ${err.message}`).catch(() => {});
  }
}

console.log(`L1 Assistant san sang (bot="${botName}", ${knowledge.fileCount} file tai lieu, namespace=${cfg.namespacePrefix}).`);

// getUpdates KHONG co hang doi: phai goi lai ngay sau moi lan tra ve, va xu ly tin
// nhan o nen (khong await) de khong lo tin toi trong luc bot dang tra loi.
while (true) {
  try {
    const res = await zalo.getUpdates(25);
    // THU DOC ANH (30/09): ghi lai CAU TRUC tin khong phai chu (anh, file, sticker) de biet Zalo
    // gui anh cho bot ra sao (co link anh khong). Chi ghi ten truong + link, khong luu noi dung anh.
    if (res?.ok && res.result && !res.result.message?.text && res.result.message?.message_type !== "CHAT_PHOTO") {
      console.log(`[zalo] tin khong phai chu: ${JSON.stringify(res.result).slice(0, 1500)}`);
    }
    if (res?.ok && res.result?.message) onMessage(res.result.message);
  } catch (err) {
    console.error("[zalo] getUpdates loi:", err.message);
    await sleep(5000);
  }
}
