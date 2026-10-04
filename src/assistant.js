import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractCodes, stamp, nowStamp, parseStamp } from "./memory.js";
import { createLocalKb } from "./localKb.js";
import { geocode, getWeatherAt } from "./weather.js";
import { md, fmtWorkflow, fmtMissing, fmtTaught, fmtClarify, shortDate } from "./format.js";

const HELP = [
  "L1 Assistant - cách dùng:",
  '- Hỏi nghiệp vụ: "check-in báo ngoài phạm vi xử lý sao?", "SR-1042 có lịch sử gì?", "ca trước bàn giao gì?"',
  '- Hỏi tiếng Anh: "dịch câu này: ...", "từ deploy đọc sao?", "phiên âm của schedule?"',
  '- Thời tiết: "thời tiết Sài Gòn mấy ngày tới?", "weather Hanoi"',
  "- Hỏi chung: hỏi gì đáp nấy bằng kiến thức chung.",
  "- Ghi bàn giao ca:  bàn giao: <nội dung>",
  "- Ghi cuộc gọi/mail:  log: <nội dung, kèm mã SR-/OUT-/NPP->",
  "- Dạy bot cách fix mới:  dạy: <nội dung>",
  "- Ghi nhớ riêng cho mình:  ghi nhớ: <nội dung>",
  "- Dạy/đính chính không cần gõ \"dạy:\", không cần nhắc lại câu hỏi: bot tự hiểu và ghép với câu vừa hỏi.",
  "(Bộ nhớ lưu mã hoá trên Walrus.)",
].join("\n");

// Dang text bat buoc co dau ":" de khong nham voi cau hoi (vd "ban giao hom nay co gi?").
const COMMANDS = [
  { kind: "handover", re: /^(?:\/bangiao\s+|b[aà]n\s*giao\s*:\s*)/i },
  { kind: "log", re: /^(?:\/log\s+|log\s*:\s*)/i },
  { kind: "teach", re: /^(?:\/day\s+|d[aạ]y\s*:\s*)/i },
  { kind: "note", re: /^(?:\/note\s+|ghi\s*nh[oớ]\s*:\s*)/i },
];

// Cau hoi ve he thong noi bo ma LLM lo xep vao "kien thuc chung" -> ep ve chua co (chong bia).
const SYSTEM_RE = /\b(?:fieldgo|dms|e-?contract|survey\s*app|b2b|workflow|npp|outlet|routeid|route|bi|power\s*bi|jira|ticket|servicedesk|portal|sap|cooler|novasoft)\b/i;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// Walrus binh thuong tra 1 kho mat 0.7-3.3s (do 26/09); qua 5s coi nhu cham -> ban du phong.
// (Truoc la 9s: relayer cham la user cho ~9s.)
const RECALL_TIMEOUT_MS = 5000;
// Vong lap cong cu (agentic co kiem soat): toi da 3 lan tra / 1 cau hoi roi buoc phai tra loi.
const MAX_TOOL_STEPS = 3;
const QUESTION_WORDS = /\?|(?:^|\s)(?:sao|th[eế]\s*n[aà]o|l[aà]m\s*g[iì]|nh[uư]\s*n[aà]o|ntn|[dđ][aâ]u|g[iì]|n[aà]o|kh[oô]ng|ko|ch[uư]a|h[aả]|nh[iỉ]|v[aậ]y|ph[aả]i\s*kh[oô]ng)\s*[.!]*$/i;

const HANDOVER_Q = /b[aà]n\s*giao|ca\s*tr[uư][oớ]c|ca\s*s[aá]ng|ca\s*chi[eề]u|[dđ]ang\s*d[oở]|pending/i;
const DAY_MS = 24 * 60 * 60 * 1000;

// Kien thuc day kem "chua verify / chua chac / co the la..." -> danh dau de khi
// tra loi bot canh bao, tranh L1 bao khach thong tin chua chac (ca 25/09 E-Contract).
const UNVERIFIED_RE = /ch[uư]a\s*(?:[dđ][uư][oợ]c\s*)?(?:verify|x[aá]c\s*nh[aậ]n|ki[eể]m\s*ch[uứ]ng|ch[aắ]c)|c[oó]\s*th[eể]\s*l[aà]|h[iì]nh\s*nh[uư]|unverified/i;
const UNVERIFIED_TAG = "(CHƯA VERIFY)";

// Cau hoi nghiep vu bot vua xu ly, giu theo group de ghep voi "day:" gui sau ma
// KHONG nhac lai ngu canh (Zalo khong gui kem thong tin reply tin nao).
const GAP_TTL_MS = 3 * 60 * 60 * 1000;
const GAP_MAX = 5;

// Moi file tai lieu toi da N mau: tranh 1 file co nhieu muc na na nhau (vd
// issues-and-resolutions.md) chiem het top-k, day quy trinh chuan WFxx ra ngoai
// (ca 25/09: WF44 dung thu 6, bot chi lay 4 -> tra loi theo ban day cu).
function sourceKey(text) {
  const t = String(text).replace(/^\(cập nhật [^)]*\)\s*/, "");
  const wf = /^WF\d+/.exec(t);
  if (wf) return wf[0];
  // Gioi han theo MUC (duong dan heading day du), khong theo ca file: cac mau na na cung
  // 1 muc van bi gioi han; cac muc khac nhau cua 1 tai lieu chuyen sau (SLA, timeline,
  // nguyen nhan...) deu duoc lay (ca 26/09: timeline 1 incident bi cat do gioi han theo file).
  const section = /^\[([^\]]+)\]/.exec(t);
  return section ? section[1] : t.slice(0, 40);
}
function diversify(hits, { perSource = 2, max = 5 } = {}) {
  const count = new Map();
  const out = [];
  for (const h of hits) {
    const k = sourceKey(h.text);
    if ((count.get(k) || 0) >= perSource) continue;
    count.set(k, (count.get(k) || 0) + 1);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

const ymdVN = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" });

function parseJson(s) {
  const str = String(s);
  const a = str.indexOf("{");
  if (a < 0) return null;
  // Gemini hay tra JSON hong: de nguyen dau " trong cau ("top 1", "vuong mien"), du dau "}}",
  // du dau phay ",,", ... -> bot tung gui nguyen chuoi {"kind":...} vao group (28-29/09).
  // Thu lan luot: nguyen van -> sua dau " / dau phay -> cat bot "}" thua o cuoi.
  let b = str.lastIndexOf("}");
  for (let tries = 0; b > a && tries < 3; tries++, b = str.lastIndexOf("}", b - 1)) {
    const body = str.slice(a, b + 1);
    for (const fix of [(x) => x, repairQuotes, (x) => fixCommas(repairQuotes(x))]) {
      try {
        return JSON.parse(fix(body));
      } catch {
        // thu cach sua tiep theo
      }
    }
  }
  return null;
}

// Dau phay thua ngoai chuoi: ",," / "[," / ",]" / ",}".
function fixCommas(j) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < j.length; i++) {
    const c = j[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += j[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ",") {
      const prev = out.trimEnd().slice(-1);
      const next = /^\s*(\S)/.exec(j.slice(i + 1))?.[1];
      if (prev === "," || prev === "[" || prev === "{" || next === "]" || next === "}") continue;
    }
    out += c;
  }
  return out;
}

// Dau " o GIUA chuoi (sau no khong phai , } ] :) -> escape thanh \"; xuong dong tran -> \n.
function repairQuotes(j) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < j.length; i++) {
    const c = j[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
    } else if (c === "\\") {
      out += c + (j[i + 1] ?? "");
      i++;
    } else if (c === '"') {
      const next = /^\s*(\S)/.exec(j.slice(i + 1))?.[1];
      if (next === undefined || ",}]:".includes(next)) {
        inStr = false;
        out += c;
      } else out += '\\"';
    } else out += c === "\n" ? "\\n" : c;
  }
  return out;
}

// Van hong -> lay rieng truong "text"; khong lay duoc ma trong nhu JSON -> bao loi nhe nhang.
// KHONG bao gio gui nguyen JSON cho nguoi dung.
function looseText(raw) {
  const t = String(raw).trim();
  const m = /"text"\s*:\s*"([\s\S]*?)"\s*\}*\s*$/.exec(t);
  if (m) return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  return /^\s*\{\s*"kind"/.test(t) ? "Mình soạn câu trả lời bị lỗi định dạng, bạn hỏi lại giúp mình nhé." : "";
}

// PHIEN CHAT: tin trong cung 1 group cach nhau < 10 phut = 1 doan trao doi. Giu NGUYEN
// VAN ca tin nguoi hoi lan cau bot tra loi (truoc day cat 300 ky tu -> Gemini chi thay nua
// cau tra loi 5 buoc, "lam tiep nhu may moi phan hoi" khong hieu). Het phien -> tom tat
// len MemWal (tri nho dai han cua rieng group do).
const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_MAX_TURNS = 20;
const SESSION_MAX_CHARS = 9000;
const TURN_MAX_CHARS = 2500;
// Gui Gemini chi ~10 tin gan nhat (du hieu mach chat, it token); du 20 tin chi dung luc tom tat phien.
const CONTEXT_TURNS = 10;
const CONTEXT_MAX_CHARS = 6000;
// Nhieu chu de xen ke trong 1 phien (2 nguoi hoi 2 viec) -> giu toi da 6 chu de gan nhat.
const TOPIC_MAX = 6;
// Phan cap nguon (Ha chot 27/09, phuong an B): cau day cua nguoi duyet (Ha) coi nhu da duyet,
// thang ngay; cau day cua nguoi khac CHUA DUYET: mau thuan WF thi van theo WF + hien canh bao.
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const APPROVER_RE = new RegExp(`^(?:${(process.env.KB_APPROVERS || "Ha").split(",").map((x) => escRe(x.trim())).join("|")})\\b`, "i");

export function createAssistant({ memory, ask, askStrong = ask, knowledge, directory, incident, usageLogPath, addendumPath, includePrivateKb, kbPointerPath, kbCacheDir, statePath, sessionIdleMs = SESSION_IDLE_MS, jiraTools = false, runTool = null, mergedPath = "" }) {
  const { ns } = memory;
  const localKb = createLocalKb({ cacheDir: kbCacheDir, addendumPath, parseStamp });
  const RECENT_TAUGHT_MS = 15 * 60 * 1000; // Walrus can ~30s+ moi index xong 1 lan "day:"
  const bodyKey = (t) => String(t).replace(/^\[[^\]]*\] \[[^\]]*\] /, "").replace(UNVERIFIED_TAG, "").replace(/\s+/g, " ").trim().slice(0, 60);

  // Walrus Memory chi ghi them, KHONG xoa duoc mau cu -> tai lieu nap theo PHIEN BAN
  // (kb:v2, kb:v3...), nap xong moi doi con tro trong kb-version.json. Doc lai file
  // khi mtime doi -> bot chuyen kho ngay, khong can restart, khong bao gio lan 2 ban.
  const prefix = ns.kb.replace(/:kb$/, "");
  let kbCache = { mtime: -1, ptr: null };
  async function kbNamespaces() {
    if (kbPointerPath) {
      try {
        const st = await stat(kbPointerPath);
        if (st.mtimeMs !== kbCache.mtime) {
          kbCache = { mtime: st.mtimeMs, ptr: JSON.parse(await readFile(kbPointerPath, "utf8"))[prefix] || null };
        }
      } catch {
        kbCache = { mtime: -1, ptr: null };
      }
    }
    return { kb: kbCache.ptr?.kb || ns.kb, kbpriv: kbCache.ptr?.kbpriv || ns.kbpriv, kbwf: kbCache.ptr?.kbwf || "" };
  }

  // Ghi noi dung "day:" vao file addendum (kem ai day + gio) de Ha duyet/merge
  // sau - KHONG dong vao file goc. Chi bat khi cau hinh ADDENDUM_FILE.
  async function appendAddendum(userName, body, when = nowStamp()) {
    if (!addendumPath) return;
    try {
      await appendFile(addendumPath, `\n## [${when}] ${userName} dạy:\n${body}\n`);
    } catch (err) {
      console.error("[addendum] khong ghi duoc:", err.message);
    }
  }

  // Kho "ghi nho tu dong" + ky uc hoi thoai TACH theo pham vi: group L1 (bot production) va
  // group nguoi than/tin rieng (Bot Walrus) truoc day dung chung team:auto -> chuyen rieng
  // cua ben nay co the hien ra khi tra loi ben kia (kiem tra 27/09).
  const autoNs = includePrivateKb ? `${prefix}:priv:auto` : ns.auto;
  const chatNs = (chatId) => `${prefix}:chat:${chatId}`;

  // chatId -> { turns: [{ who, text, at, topic }], topics: [{ id, label, at }], nextTopic, startedAt, lastAt }
  const sessions = new Map();
  // kind: "missing" (bot chua biet, dang cho day) | "answered" (da tra loi, co the bi dinh chinh)
  const gaps = new Map();

  // Ghi phien + cau dang cho ra file NGAY moi tin (file nho) -> restart/deploy ngay sau cau
  // tra loi cung khong mat (ban hen 1s truoc do bi systemctl restart cat ngang, test 27/09).
  function saveState() {
    if (!statePath) return;
    try {
      mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: [...sessions], gaps: [...gaps] }));
      renameSync(tmp, statePath);
    } catch (err) {
      console.error("[state] khong ghi duoc:", err.message);
    }
  }
  if (statePath) {
    try {
      const st = JSON.parse(readFileSync(statePath, "utf8"));
      for (const [k, v] of st.sessions || []) sessions.set(k, v);
      for (const [k, v] of st.gaps || []) gaps.set(k, v);
      console.log(`[state] nap lai ${sessions.size} phien chat, ${gaps.size} nhom co cau dang cho`);
    } catch {
      // chua co file lan dau chay
    }
  }

  // Bo markup Zalo (mau, escape, tieu de) nhung GIU xuong dong/cac buoc.
  function plain(text) {
    return String(text)
      .replace(/\{\/?\w+\}/g, "")
      .replace(/\\([\\*_`~#>])/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/^_(.*)_$/gm, "$1")
      .trim();
  }
  const hhmm = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" }).format(ms);

  function currentSession(chatId) {
    const s = sessions.get(chatId);
    if (s && Date.now() - s.lastAt > sessionIdleMs) {
      endSession(chatId, s);
      return null;
    }
    return s || null;
  }
  function endSession(chatId, s) {
    sessions.delete(chatId);
    saveState();
    summarizeSession(chatId, s);
  }
  // Phien im lang qua 10 phut -> dong + tom tat, khong doi toi tin nhan ke tiep.
  setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.lastAt > sessionIdleMs) endSession(id, s);
  }, 60 * 1000).unref();

  // Khong truyen topic: ca doan chat, moi dong gan nhan "(#n)" = chu de -> bo dieu phoi chon tin
  // moi thuoc chu de nao. Co topic: CHI cac luot cua chu de do (tra loi / chuan hoa loi day),
  // tranh lan chu de khac dang noi xen trong cung 10 phut. exclude = tin vua ghi (dang xu ly).
  function recentContext(chatId, { topic, exclude } = {}) {
    if (!chatId) return "";
    const s = currentSession(chatId);
    if (!s) return "";
    const tagged = topic === undefined;
    const turns = s.turns.filter((t) => t !== exclude && (tagged || t.topic === topic));
    const lines = turns.slice(-CONTEXT_TURNS).map((t) => `[${hhmm(t.at)}]${tagged && t.topic ? ` (#${t.topic})` : ""} ${t.who}: ${t.text}`);
    while (lines.length > 2 && lines.join("\n").length > CONTEXT_MAX_CHARS) lines.shift();
    return lines.join("\n");
  }
  function pushTurn(chatId, who, text, topic) {
    if (!chatId) return null;
    const now = Date.now();
    // Cau bot tra loi luon thuoc phien cua cau hoi vua roi (tra loi lau cung khong tach phien).
    const s = (who === "Bot" ? sessions.get(chatId) : currentSession(chatId)) || { turns: [], topics: [], nextTopic: 1, startedAt: now, lastAt: now };
    const turn = { who, text: plain(text).slice(0, TURN_MAX_CHARS), at: now, ...(topic ? { topic } : {}) };
    s.turns.push(turn);
    while (s.turns.length > SESSION_MAX_TURNS || (s.turns.length > 2 && s.turns.reduce((n, t) => n + t.text.length, 0) > SESSION_MAX_CHARS)) s.turns.shift();
    s.lastAt = now;
    sessions.set(chatId, s);
    saveState();
    return turn;
  }
  // Chu de dang mo trong phien (moi nhat sau cung).
  function openTopics(chatId) {
    return sessions.get(chatId)?.topics || [];
  }
  // Gan tin vua toi vao chu de bo dieu phoi chon (pick = so chu de dang mo; khong khop = mo moi).
  function assignTopic(chatId, turn, pick, label) {
    const s = sessions.get(chatId);
    if (!s || !turn) return undefined;
    s.topics ||= [];
    s.nextTopic ||= 1;
    let t = s.topics.find((x) => x.id === pick);
    if (!t) {
      t = { id: s.nextTopic++, label: String(label || turn.text).replace(/\s+/g, " ").slice(0, 60) };
      s.topics.push(t);
      while (s.topics.length > TOPIC_MAX) s.topics.shift();
    }
    // Chu de vua duoc noi toi xep cuoi (moi nhat).
    t.at = Date.now();
    s.topics = [...s.topics.filter((x) => x !== t), t];
    turn.topic = t.id;
    saveState();
    return t.id;
  }

  // LOP 2: het phien -> Gemini tom tat thanh 1 ky uc ngan (neu dang nho) -> MemWal, kho
  // RIENG cua group do. Lan sau hoi chuyen lien quan -> tra ra (tim theo nghia).
  async function summarizeSession(chatId, s) {
    // Phien cua bo test dem: khong tom tat (kho chi doc, ton them luot goi Gemini luc dang test).
    if (String(chatId).startsWith("eval-")) return;
    // Moi chu de tom tat + luu RIENG (2 viec noi xen trong 1 phien khong bi tron vao 1 ky uc).
    const byTopic = new Map();
    for (const t of s.turns) byTopic.set(t.topic || 0, [...(byTopic.get(t.topic || 0) || []), t]);
    for (const turns of byTopic.values()) await summarizeTopic(chatId, turns);
  }
  async function summarizeTopic(chatId, turns) {
    try {
      const people = turns.filter((t) => t.who !== "Bot");
      if (!people.length || turns.length < 2) return;
      const r = parseJson(
        await ask({
          system: [
            "Bạn là bộ lọc KÝ ỨC của bot nhóm chat: chỉ giữ những gì lần sau thật sự dùng lại được. Chỉ trả về 1 object JSON:",
            '{"worth":true/false,"type":"decision"|"known_issue"|"case"|"finding"|"workaround"|"preference","memory":"<≤ 3 câu tiếng Việt>","ttlDays":<số ngày còn giá trị, 0 = lâu dài>}',
            "- Chỉ giữ (worth=true): quyết định của nhóm; known issue mới; case đang theo dõi CÓ mã/tên cụ thể (SR-, NPP-, ticket, tên SR); phát hiện khi điều tra; workaround đã xác nhận; sở thích/cách làm việc của người trong nhóm.",
            "- Bỏ (worth=false): chỉ tra 1 quy trình đã có trong tài liệu, bot hướng dẫn lại các bước có sẵn, chào hỏi, đùa, cảm ơn, chê bot, thời tiết, lời hẹn chung chung không gắn case cụ thể.",
            "- ttlDays: case đang theo dõi / lời hẹn gắn case → 14; quyết định, known issue, workaround, sở thích → 0.",
            "- Ghi đúng tên người, mã, ngày tháng có trong đoạn chat. KHÔNG ghi số điện thoại, email, mật khẩu, token. Không thêm thông tin ngoài đoạn chat.",
          ].join("\n"),
          prompt: turns.map((t) => `[${hhmm(t.at)}] ${t.who}: ${t.text}`).join("\n"),
        })
      );
      if (!r?.worth || !String(r.memory || "").trim()) return;
      const who = [...new Set(people.map((t) => t.who))].join(", ");
      // Chan PII lot qua: so dien thoai, email.
      const clean = String(r.memory).trim().replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]").replace(/(?:\+?84|0)\d{9,10}\b/g, "[sđt]");
      const ttl = Math.max(0, Math.min(90, parseInt(r.ttlDays, 10) || 0));
      const tag = `(loại: ${r.type || "case"}${ttl ? `, hết hạn ${ymdVN.format(Date.now() + ttl * DAY_MS)}` : ""})`;
      const text = `${tag} ${clean}`;
      await memory.remember(chatNs(chatId), stamp(who, text, extractCodes(text)));
      console.log(`[session] da luu ky uc phien (${turns.length} luot${turns[0].topic ? `, chu de #${turns[0].topic}` : ""}) -> ${chatNs(chatId)}`);
    } catch (err) {
      console.warn("[session] khong tom tat duoc:", err.message);
    }
  }

  function listGaps(chatId, kinds) {
    const now = Date.now();
    const arr = (gaps.get(chatId) || []).filter((g) => now - g.at < GAP_TTL_MS);
    gaps.set(chatId, arr);
    return kinds ? arr.filter((g) => kinds.includes(g.kind)) : arr;
  }
  // extra (voi "answered"): ref = WF bot vua dung, summary = cac buoc da tra loi -> cau
  // day ngan kieu "version moi la v5.9.0" van ghep dung vao cau hoi + WF do.
  function addGap(chatId, question, kind, extra = {}) {
    if (!chatId) return;
    const arr = listGaps(chatId).filter((g) => g.question !== question);
    arr.push({ question, kind, at: Date.now(), ...extra });
    while (arr.length > GAP_MAX) arr.shift();
    gaps.set(chatId, arr);
    saveState();
  }
  function dropGap(chatId, gap) {
    gaps.set(chatId, (gaps.get(chatId) || []).filter((g) => g !== gap));
    saveState();
  }

  // BO DIEU PHOI (Gemini): 1 lan goi LLM doc ngu canh + cac cau bot vua tra loi/chua co,
  // quyet dinh tin moi la HOI, DAY (chi dan/dinh chinh) hay hoi THOI TIET, va neu la day
  // thi dang day cho cau hoi nao. Thay cho regex cu (khi/neu..., dau ?, chu "mua") vi
  // regex khong hieu y (ca 26/09 15:45: Ha dinh chinh "can phan loai ro 2 tang layer..."
  // bi coi la cau hoi).
  // CONG CU (agentic co kiem soat): Gemini CHI chon cong cu trong danh sach nay + dien tham so;
  // truy van/cach tinh do code viet san, CHI DOC, chay ben bot production (cong noi bo 8788 - token
  // Jira/tổng đài nam o do, khong o bo nao). Tham so duoc kiem lai o day VA o noi chay.
  // Bat theo tung chat (jiraTools): group L1 + tin rieng cua Ha voi Bot Walrus.
  const str = (x, n) => String(x ?? "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, n);
  const PERIODS = ["hom_nay", "hom_qua", "thang_nay", "thang_truoc", "ngay"];
  const period = (p) => ({ period: PERIODS.includes(p.period) ? p.period : "hom_nay", ...(p.period === "ngay" ? { date: String(p.date || "").replace(/[^\d/-]/g, "").slice(0, 10) } : {}) });
  const TOOLS = {
    ticket_theo_nguoi: (p) => ({ name: str(p.name, 40), self: p.self === true || !str(p.name, 40) }),
    ticket_pending_lau: (p) => ({ days: Math.min(60, Math.max(1, parseInt(p.days, 10) || 3)), name: str(p.name, 40) }),
    ticket_sla: (p) => ({ kind: p.kind === "sap_het_han" ? "sap_het_han" : "qua_han", name: str(p.name, 40), self: p.self === true }),
    tong_quan: () => ({}),
    ticket_loc: (p) => ({
      ...(str(p.nguoi_raise, 40) ? { nguoi_raise: str(p.nguoi_raise, 40) } : {}),
      ...(str(p.nguoi_xu_ly, 40) ? { nguoi_xu_ly: str(p.nguoi_xu_ly, 40) } : {}),
      cap: ["L1", "L2", "tat_ca"].includes(p.cap) ? p.cap : "tat_ca",
      trang_thai: ["dang_mo", "pending", "cho_khach", "dang_o_L2"].includes(p.trang_thai) ? p.trang_thai : "dang_mo",
      ...(str(p.nhom, 30) ? { nhom: str(p.nhom, 30) } : {}),
      ...(parseInt(p.days, 10) > 0 ? { days: Math.min(90, parseInt(p.days, 10)) } : {}),
      ...(p.chi_tiet === true ? { chi_tiet: true } : {}),
    }),
    ticket_goi_y: (p) => ({ key: String(p.key || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 14) }),
    callcenter_tong_quan: (p) => period(p),
    callcenter_agent: (p) => ({ ...period(p), name: str(p.name, 40), self: p.self === true || !str(p.name, 40) }),
    callcenter_top: (p) => ({ ...period(p), metric: ["nhan_nhieu", "miss_nhieu", "ti_le_miss_thap", "ti_le_miss_cao"].includes(p.metric) ? p.metric : "nhan_nhieu" }),
  };
  const TOOL_GUIDE = [
    "JIRA (ticket đang mở của team L1):",
    '  • ticket_theo_nguoi {"name":"<tên người được hỏi>"} hoặc {"self":true} khi hỏi ticket của chính mình',
    '  • ticket_pending_lau {"days":<số ngày tối thiểu từ lúc tạo, mặc định 3>,"name":"<tuỳ chọn, chỉ khi hỏi riêng 1 người>"} — ticket mở đã lâu, tồn đọng',
    '  • ticket_sla {"kind":"qua_han"|"sap_het_han","name":"<tuỳ chọn>","self":<true nếu hỏi của chính mình>} — ticket đã quá hạn SLA / sắp hết hạn',
    "  • tong_quan {} — tổng quan ticket đang mở theo từng người",
    '  • ticket_loc {"nguoi_raise":"<tên người tạo/raise ticket>","nguoi_xu_ly":"<tên người đang giữ, vd Khoa L2>","cap":"L1"|"L2"|"tat_ca","trang_thai":"dang_mo"|"pending"|"cho_khach"|"dang_o_L2","nhom":"<B2B Portal/DMS/FieldGo...>","days":<mở từ X ngày>,"chi_tiet":<true CHỈ khi người hỏi muốn xem update/action/comment mới nhất, lịch sử trạng thái>} — LỌC SÂU, gồm cả ticket ĐÃ ESCALATE L2 (Level 2). Chỉ điền ô được nhắc. Dùng khi hỏi theo người raise, theo người L2, ticket escalate L2, theo nhóm, hoặc kết hợp nhiều điều kiện.',
    '  • ticket_goi_y {"key":"SUP-xxxxxx"} — đọc TOÀN BỘ 1 ticket (mô tả, comment, lịch sử) rồi tóm tắt đang tới đâu + L1 nên làm gì tiếp. Dùng khi hỏi về 1 ticket CỤ THỂ: "ticket 159589 tới đâu rồi", "L1 cần làm gì tiếp", "tóm tắt ticket X". Nói "ticket đó/ticket đầu tiên" → lấy mã từ hội thoại.',
    "CALL CENTER (tổng đài — số cuộc gọi nhận/miss của từng agent L1). period: hom_nay | hom_qua | thang_nay | thang_truoc | ngay (kèm \"date\":\"DD/MM\"); không nói kỳ → hom_nay; 'MTD', 'từ đầu tháng', 'tháng này' → thang_nay:",
    '  • callcenter_tong_quan {"period":...} — số nhận/miss của CẢ TEAM theo từng agent',
    '  • callcenter_agent {"name":"<tên agent>","period":...} hoặc {"self":true,...} — số của 1 người',
    '  • callcenter_top {"metric":"nhan_nhieu"|"miss_nhieu"|"ti_le_miss_thap"|"ti_le_miss_cao","period":...} — xếp hạng (ai nhận nhiều nhất, ai miss nhiều nhất, top 1...)',
  ].join("\n");

  async function classify({ chatId, input, context }) {
    // Bat/tat cong cu Jira theo tung chat (Bot Walrus: chi tin rieng cua Ha, khong group nguoi than).
    const jt = typeof jiraTools === "function" ? jiraTools(chatId) : jiraTools;
    const list = listGaps(chatId);
    const topics = openTopics(chatId);
    const r = parseJson(
      await ask({
        system: [
          "Bạn là bộ điều phối tin nhắn cho bot hỗ trợ team L1 support (FieldGo, DMS, Cooler Audit, Workflow, E-Contract...). Chỉ trả về 1 object JSON:",
          `{"intent":"ask"|"teach"|"weather"${jt ? '|"tool"' : ""},"topic":<số chủ đề đang mở mà tin mới nói tiếp, 0 = chủ đề mới>,"topicLabel":"<khi topic=0: tên chủ đề ≤ 8 từ>","gap":<số thứ tự câu đang chờ, 0 nếu không>,"situation":"<tình huống, ≤ 25 từ, chỉ khi teach>","query":"<chỉ khi ask: câu hỏi viết lại ĐẦY ĐỦ, tự hiểu được không cần đọc hội thoại>"${jt ? ',"tool":"<chỉ khi tool>","params":{},"more":<true/false, chỉ khi tool>' : ""}}`,
          ...(jt
            ? [
                "- tool: hỏi SỐ LIỆU / DANH SÁCH đang có trên hệ thống: ticket Jira của team (của ai, còn bao nhiêu, pending/tồn lâu, SLA), hoặc cuộc gọi call center (ai nhận/miss bao nhiêu, top 1, tỉ lệ miss, hôm nay/tháng này). Chọn ĐÚNG 1 tool đầu tiên và điền params, KHÔNG viết truy vấn:",
                TOOL_GUIDE,
                "  Ví dụ: 'ticket của tôi' → ticket_theo_nguoi {\"self\":true}; 'An còn mấy case/ticket chưa đóng' → ticket_theo_nguoi {\"name\":\"An\"}; 'ticket nào pending lâu' → ticket_pending_lau {\"days\":3}; 'ticket của Bình tồn hơn 10 ngày' → ticket_pending_lau {\"days\":10,\"name\":\"Bình\"}; 'ticket nào sắp trễ SLA' → ticket_sla {\"kind\":\"sap_het_han\"}; 'cả team còn bao nhiêu ticket' → tong_quan {}; 'hôm nay ai miss nhiều nhất' → callcenter_top {\"metric\":\"miss_nhieu\",\"period\":\"hom_nay\"}; 'Chi tháng này nhận bao nhiêu cuộc' → callcenter_agent {\"name\":\"Chi\",\"period\":\"thang_nay\"}; 'call center hôm qua thế nào' → callcenter_tong_quan {\"period\":\"hom_qua\"}; 'tháng này ai tỉ lệ miss cao nhất' → callcenter_top {\"metric\":\"ti_le_miss_cao\",\"period\":\"thang_nay\"}; 'ticket L1 raise đang escalate L2 cho Khoa L2' → ticket_loc {\"cap\":\"L2\",\"nguoi_xu_ly\":\"Khoa L2\"}; 'ticket An raise đã lên L2' → ticket_loc {\"cap\":\"L2\",\"nguoi_raise\":\"An\"}; 'ticket B2B Portal nào đang ở L2 quá 5 ngày' → ticket_loc {\"cap\":\"L2\",\"nhom\":\"B2B Portal\",\"days\":5}; 'show các ticket escalate cho Khoa L2 kèm update/action mới nhất' → ticket_loc {\"cap\":\"L2\",\"nguoi_xu_ly\":\"Khoa L2\",\"chi_tiet\":true}; 'ticket 159589 L1 cần làm gì tiếp' → ticket_goi_y {\"key\":\"SUP-159589\"}; nối tiếp 'kèm comment mới nhất đi' → giữ ô lọc lần trước + \"chi_tiet\":true.",
                "  'ticket của tôi/của mình/của em' (không kèm điều kiện khác) LUÔN là ticket_theo_nguoi {\"self\":true}, kể cả ngay sau 1 lần tra khác.",
                "  Câu hỏi ĐẦY ĐỦ (tự nêu rõ muốn gì) → xét theo chính câu đó, KHÔNG lấy lại tool/params câu trước. Câu NỐI TIẾP nói tắt ngay sau 1 lần tra (vd 'còn của Bình thì sao', 'chỉ lấy hơn 10 ngày thôi', 'còn hôm qua thì sao', 'còn Chi?') → giữ tool/params của lần tra trước (dòng 'Bot: (đã tra: ...)' trong hội thoại), chỉ đổi phần vừa được nhắc. 'case' trong câu hỏi về ai đó còn bao nhiêu = ticket.",
                "  more = true khi câu hỏi cần THÊM ngoài 1 lần tra: nhận xét/đánh giá/so sánh dựa trên số liệu ('có đáng lo không', 'ai nên được khen'), hoặc cần tra 2 thứ, hoặc cần kèm quy trình/cách xử lý trong tài liệu. Chỉ xem số/danh sách → false.",
                "  Hỏi về cách xử lý 1 lỗi (có chữ ticket) thì KHÔNG phải tool mà là ask.",
              ]
            : []),
          "- Trả lời cho câu bot VỪA HỎI LẠI trong đoạn đang chat (vd 'có rồi', 'chưa', 'bản cũ', 'xem hết') → ask; query = vấn đề gốc + thông tin vừa trả lời (vd 'Cooler Audit đã có trên server nhưng không lên báo cáo: xử lý sao').",
          "- ask TRƯỚC TIÊN: người nhắn đang HỎI / XIN bot hướng dẫn (có 'sao', 'gì', 'thế nào', 'ntn', 'không', 'nhỉ', 'hả', '?', 'giải thích', 'trả lời ngắn thôi'...) → ask, KỂ CẢ khi hỏi tiếp/hỏi lại/hỏi rõ hơn về nội dung bot vừa trả lời trong đoạn đang chat.",
          "- teach: người nhắn KHẲNG ĐỊNH cho bot cách làm: đang HƯỚNG DẪN / DẠY / ĐÍNH CHÍNH / BỔ SUNG cách xử lý (L1 phải làm gì, kiểm tra gì, báo user gì, phân loại trường hợp ra sao), kể cả không gõ 'dạy:', kể cả câu mở đầu bằng tình huống ('SR báo X thì mày cần...'), kể cả sửa lại câu bot vừa trả lời ('không phải vậy', 'mày cần phân loại rõ...', 'version mới là ...'), kể cả trả lời cho câu bot vừa báo chưa có tài liệu.",
          "- weather: thật sự hỏi thời tiết/mưa/nắng/nhiệt độ ở đâu đó (chê bot hay cảm thán có chữ 'mưa' KHÔNG tính).",
          "- ask: mọi trường hợp còn lại (câu hỏi nghiệp vụ, tiếng Anh, hỏi chung, kể chuyện, cảm thán, chê, cảm ơn, chào hỏi).",
          "- topic: đoạn chat có thể có NHIỀU chủ đề xen kẽ (mỗi dòng gắn (#n), danh sách CHỦ ĐỀ ĐANG MỞ). Tin mới NỐI TIẾP / hỏi thêm / trả lời câu bot hỏi lại / bổ sung / dạy / đính chính cho chủ đề nào → số chủ đề đó (kể cả 'quay lại vụ X', câu nói tắt). Hỏi/bàn tiếp về DỮ LIỆU hay NỘI DUNG vừa đưa ra trong 1 chủ đề (vd vừa gửi báo cáo call center rồi hỏi 'ai xứng đáng top 1', 'trao thưởng gì') → chủ đề đó, dù câu tự đứng được. Chỉ mở chủ đề mới (0, đặt topicLabel) khi tin nói về vấn đề/hệ thống KHÁC HẲN, không dính gì tới các chủ đề đang mở (vd đang bàn Cooler Audit rồi hỏi lỗi 504). Không chắc → chủ đề gần nhất. Chào hỏi, cảm ơn, chê bot, đùa → chủ đề gần nhất. Không có chủ đề nào đang mở → 0.",
          "- query và situation viết theo ĐÚNG chủ đề đã chọn ở topic, không lấy nội dung của chủ đề khác.",
          "- gap (khi teach): số thứ tự câu trong danh sách chờ mà chỉ dẫn này dành cho (cùng vấn đề, hoặc sửa câu bot vừa trả lời); 0 nếu không khớp câu nào.",
          "- situation (khi teach): vấn đề/tình huống mà chỉ dẫn xử lý, viết thành 1 câu rõ nghĩa. Ghép được câu chờ thì dựa vào câu đó; không thì lấy từ chính tin nhắn/hội thoại.",
          "- query (khi ask): câu hỏi nối tiếp hay nói tắt ('vậy bước 2 nâng lên bản nào', 'còn DMS thì sao', 'case đó thế nào rồi') → viết lại thành câu đầy đủ, nêu rõ hệ thống/vấn đề đang nói trong hội thoại (vd 'Cooler Audit không lên server: nâng version app FieldGo lên bản nào, đã ở bản mới thì xử lý sao'). Câu đã đủ nghĩa thì giữ nguyên.",
        ].join("\n"),
        prompt: [
          "HỘI THOẠI GẦN ĐÂY:",
          context || "(không có)",
          "",
          "CHỦ ĐỀ ĐANG MỞ (cũ → mới):",
          topics.length ? topics.map((t) => `#${t.id} ${t.label} (tin cuối ${hhmm(t.at)})`).join("\n") : "(không có)",
          "",
          "CÂU ĐANG CHỜ (bot vừa trả lời hoặc vừa báo chưa có):",
          list.length
            ? list.map((g, i) => `${i + 1}. ${g.question} → ${g.kind === "missing" ? "bot báo CHƯA CÓ tài liệu" : `bot đã trả lời${g.ref ? ` theo ${g.ref}` : ""}: ${g.summary || ""}`}`).join("\n")
            : "(không có)",
          "",
          `TIN NHẮN MỚI: ${input}`,
        ].join("\n"),
      }).catch((err) => {
        console.warn("[route] LLM loi, coi nhu cau hoi:", err.message);
        return "";
      })
    );
    // "jira" = ten cu cua "tool" (giu tuong thich).
    let intent = r?.intent === "jira" ? "tool" : r?.intent;
    intent = ["ask", "teach", "weather", ...(jt ? ["tool"] : [])].includes(intent) ? intent : "ask";
    const hasTool = jt && Object.prototype.hasOwnProperty.call(TOOLS, r?.tool);
    const call = intent === "tool" && hasTool ? { tool: r.tool, params: TOOLS[r.tool](r.params || {}) } : null;
    // Chieu xep hang ti le miss do CODE chot theo chu trong cau (Gemini lite hay chon nguoc:
    // "ai ti le miss cao nhat" -> ti_le_miss_thap, test dem 29-30/09).
    if (call?.tool === "callcenter_top" && /t[iỉỷ]\s*l[eệ]/i.test(input)) {
      if (/cao\s*nh[aấ]t|nhi[eề]u\s*nh[aấ]t|t[eệ]\s*nh[aấ]t/i.test(input)) call.params.metric = "ti_le_miss_cao";
      else if (/th[aấ]p\s*nh[aấ]t|[ií]t\s*nh[aấ]t|t[oố]t\s*nh[aấ]t/i.test(input)) call.params.metric = "ti_le_miss_thap";
    }
    if (intent === "tool" && !call) intent = "ask";
    const gap = list[(parseInt(r?.gap, 10) || 0) - 1] || null;
    // LLM loi (r null) -> coi nhu noi tiep chu de gan nhat (giu hanh vi cu, khong mat ngu canh).
    const n = parseInt(r?.topic, 10);
    const topic = r && Number.isFinite(n) ? n : topics.at(-1)?.id || 0;
    return { intent, gap, situation: String(r?.situation || "").trim(), query: String(r?.query || "").trim(), call, more: r?.more === true, topic, topicLabel: String(r?.topicLabel || "").trim() };
  }

  // Cac WF co the lien quan toi 1 cau day (de chuan hoa + xac dinh sua WF nao).
  async function wfCandidates(q, ref) {
    const kbNs = await kbNamespaces();
    if (!kbNs.kbwf) return [];
    const strip = (h) => String(h.text).replace(/^\(cập nhật [^)]*\)\s*/, "");
    let wf = await safeRecall(kbNs.kbwf, q, { limit: 3, maxDistance: 0.6 })
      .then((h) => localKb.filterLive(kbNs.kbwf, h))
      .catch(() => localKb.searchKb(kbNs.kbwf, q, 2));
    wf = (wf || []).map(strip);
    // Biet san WF (cau day ghep voi cau bot vua tra loi theo WFxx) -> chac chan co mau do.
    if (ref && !wf.some((t) => t.startsWith(`${ref}.`))) {
      const own = ((await localKb.searchKb(kbNs.kbwf, ref, 5).catch(() => null)) || []).map(strip).find((t) => t.startsWith(`${ref}.`));
      if (own) wf.unshift(own);
    }
    return wf.slice(0, 2);
  }

  // CHUAN HOA cau day truoc khi luu (Gemini): viet lai thanh tinh huong + cac buoc + escalate
  // + ghi chu, KHONG them y ngoai loi day; dong thoi xac dinh la SUA 1 Y cua WF co san
  // (patch: doan cu -> moi nguyen van) hay cach xu ly MOI. Loi day goc van luu kem de doi chieu.
  async function prepareTeach({ question, body, gap, context }) {
    try {
      const wf = await wfCandidates([question, body].filter(Boolean).join("\n"), gap?.ref);
      const r = parseJson(
        await askStrong({
          system: [
            "Bạn chuẩn hoá 1 chỉ dẫn team L1 vừa dạy bot thành mục kiến thức gọn, rõ. Chỉ trả về 1 object JSON:",
            '{"situation":"<tình huống/vấn đề, 1 câu>","steps":["<bước>",...],"escalate":"<ai, khi nào>","note":"<bối cảnh/nguyên nhân>","unverified":true/false,"type":"patch"|"new","ref":"<WFxx>","edits":[{"old":"<đoạn NGUYÊN VĂN trong WF>","new":"<đoạn đó sau khi sửa>"}]}',
            "- steps: viết lại ĐỦ ý lời dạy thành các bước ngắn, hành động cụ thể, giữ nguyên điều kiện rẽ nhánh ('Nếu ... thì ...'), giữ nguyên tên hệ thống/mã/link. TUYỆT ĐỐI không thêm bước/thông tin không có trong lời dạy hoặc nguồn cho sẵn.",
            "- Lời dạy tham chiếu chỗ khác ('flow cũ', 'như mày vừa trả lời/phản hồi', 'làm tiếp như trên', 'như WF') → THAY bằng đúng các bước cụ thể lấy từ CÂU BOT VỪA TRẢ LỜI hoặc WF cho sẵn; KHÔNG để nguyên cụm tham chiếu trong steps. Câu chung chung kiểu 'phân loại rõ 2 trường hợp' → thể hiện bằng các nhánh 'Nếu ...', không thành 1 bước riêng.",
            "- escalate: CHỈ điền khi lời dạy BẢO L1 chuyển/escalate/raise ticket cho ai. Lời dạy chỉ giải thích nguyên nhân ('issue do layer X') → đưa vào note, escalate để rỗng.",
            "- unverified: true nếu người dạy tỏ ra chưa chắc (chưa verify, hình như, có thể là...).",
            "- type patch: chỉ dẫn chỉ SỬA vài chi tiết nhỏ (version, link, tên người/team, tên nút, mốc thời gian) của 1 WF đang khớp đúng vấn đề, các bước khác vẫn đúng. edits tối đa 3, old là đoạn ngắn (≤ 1 câu) chép NGUYÊN VĂN từ WF; không sửa phần lịch sử/nguyên nhân/ngày tháng (vd 'lỗi phát sinh từ v5.8.0', 'deploy 16/09/2026'). Khi patch thì steps để [].",
            "- type new: mọi trường hợp khác (cách xử lý mới, THÊM tình huống/nhánh mới, đổi từ 2 bước trở lên, chưa có WF).",
          ].join("\n"),
          prompt: [
            "WF LIÊN QUAN:",
            wf.length ? wf.join("\n\n---\n\n") : "(không có)",
            "",
            context ? `ĐOẠN ĐANG CHAT (nguyên văn):\n${context}\n` : "",
            gap?.summary ? `CÂU BOT VỪA TRẢ LỜI${gap.ref ? ` (theo ${gap.ref})` : ""}: ${gap.summary}` : "",
            question ? `CÂU HỎI/TÌNH HUỐNG: ${question}` : "",
            `LỜI DẠY: ${body}`,
          ].join("\n"),
        })
      );
      if (!r) return null;
      const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
      let patch = null;
      if (r.type === "patch" && /^WF\d+$/.test(r.ref || "")) {
        const src = norm(wf.find((t) => t.startsWith(`${r.ref}.`)) || "");
        const edits = (Array.isArray(r.edits) ? r.edits : []).map((e) => ({ old: norm(e?.old), new: norm(e?.new) }));
        // Chi nhan ban sua NHO, dung nguyen van: sua lon/viet lai ca doan = thuc chat la nhanh
        // moi (ca 26/09: chi dan "server co ma report khong len" bi viet de dong tom tat WF44).
        const small = (e) => e.old && e.new && e.old !== e.new && src.includes(e.old) && e.old.length <= 300 && e.new.length <= e.old.length + 120;
        if (edits.length && edits.length <= 3 && edits.every(small)) patch = { ref: r.ref, edits };
      }
      const steps = (Array.isArray(r.steps) ? r.steps : []).map((x) => norm(x).replace(/^(?:b[uư][oớ]c\s*)?\d+\s*[:.)-]\s*/i, "")).filter(Boolean);
      return {
        situation: norm(r.situation) || question || "",
        steps: patch ? [] : steps,
        escalate: norm(r.escalate),
        note: norm(r.note),
        unverified: !!r.unverified,
        patch,
      };
    } catch (err) {
      console.warn("[teach] khong chuan hoa duoc:", err.message);
      return null;
    }
  }

  const system = [
    'Bạn là "L1 Assistant", trợ lý nội bộ team L1 support hệ sinh thái SFA',
    "(FieldGo, DMS, Cooler Audit, Workflow, B2B Portal, E-Contract, Survey App).",
    "Giúp member L1 tra cứu quy trình xử lý issue và escalate đúng đầu mối.",
    "",
    "Bạn có 3 vai:",
    "- (A) Trợ lý nghiệp vụ support: trả lời câu hỏi về lỗi app, quy trình, escalate...",
    "- (B) Trợ lý tiếng Anh cho member trong group.",
    "- (C) Trợ lý chung: hỏi gì đáp nấy bằng kiến thức chung (giải thích, gợi ý, tính toán, viết giúp...).",
    "",
    "Nguyên tắc chung:",
    "- Trả lời tiếng Việt (trừ phần ví dụ tiếng Anh), ngắn gọn, đi thẳng vào việc.",
    '- Xưng hô TRUNG LẬP: gọi người hỏi bằng "bạn" hoặc theo tên hiển thị. TUYỆT ĐỐI không đoán giới tính, không tự dùng "anh/chị" trừ khi người đó tự xưng.',
    "- Với dữ liệu THỜI GIAN THỰC mà bạn không có (tin tức mới, tỉ giá, giá coin/chứng khoán...): nói rõ bạn không có số liệu thời gian thực, ĐỪNG bịa. (Thời tiết đã có nguồn riêng, không hỏi bạn.)",
    '- Phân biệt 3 loại tin: (1) CÂU HỎI → trả lời. (2) CUNG CẤP THÔNG TIN hữu ích (kể sự việc, số liệu, tình huống) → tiếp nhận ngắn gọn, thông tin đó sẽ được nhớ. (3) CẢM THÁN / TRÊU ĐÙA / CHÊ / CẢM ƠN / chào hỏi ("đần quá", "hay đấy", "cảm ơn nhé", "ok")→ đáp lại TỰ NHIÊN, thân thiện, ngắn (có thể đùa lại nhẹ hoặc tiếp thu), TUYỆT ĐỐI KHÔNG trả lời máy móc kiểu "Mình ghi nhận rồi nhé". Chỉ dùng câu "ghi nhận" cho loại (2).',
    "",
    "Vai (A) - nghiệp vụ support:",
    "- Chỉ được dùng phần WORKFLOW LIÊN QUAN và BỘ NHỚ cung cấp kèm theo mỗi câu hỏi (đã lọc sẵn cái khớp nhất). TUYỆT ĐỐI không bịa quy trình, không dùng kiến thức chung để chế bước.",
    "- MỌI câu hỏi về hệ thống/app nội bộ (FieldGo, DMS, Cooler Audit, E-Contract, Survey App, B2B Portal, Workflow, NPP, SR, outlet, route...) là vai (A): TUYỆT ĐỐI không trả lời bằng kiến thức chung/đoán (không dùng kind other). Không có trong tài liệu/bộ nhớ → kind missing.",
    "- TUYỆT ĐỐI không bịa link/URL, email, số điện thoại, tên người/team phụ trách. Chỉ dùng nếu có NGUYÊN VĂN trong nguồn. Không có → kind missing (kể cả câu hỏi ngắn kiểu 'link ... là gì').",
    "- HỘI THOẠI GẦN ĐÂY (đoạn đang chat, nguyên văn cả câu bot vừa trả lời), [Ghi nhớ tự động] và [Trao đổi trước đây trong nhóm này] dùng để hiểu ngữ cảnh và trả lời nối tiếp cho khớp (người hỏi 'còn bước 2 thì sao', 'case hôm qua thế nào' → dựa vào đó), KHÔNG phải nguồn workflow: không lấy nội dung chat để chế các bước xử lý.",
    '- QUAN TRỌNG: chỉ trả lời nếu có workflow khớp ĐÚNG vấn đề được hỏi. Nếu phần WORKFLOW LIÊN QUAN trống, HOẶC chỉ có workflow của cùng hệ thống nhưng KHÁC vấn đề (vd hỏi lỗi quét QR mà chỉ có workflow lỗi login) → coi như CHƯA CÓ.',
    "- Mẩu bắt đầu bằng WFxx là QUY TRÌNH CHUẨN: khi có WFxx khớp vấn đề thì dựa vào WFxx làm chính (đủ các nhánh xử lý), các mẩu ghi chú khác chỉ bổ sung. Nếu tài liệu và kiến thức team dạy nói cùng một nội dung → source \"kb\", sourceRef = WFxx.",
    "- Kiến thức team dạy chia 2 khối: [ĐÃ DUYỆT (Ha)] và [CHƯA DUYỆT], mỗi khối xếp MỚI → CŨ (header [thời gian] [người]).",
    "- Mục ĐÃ DUYỆT mâu thuẫn nhau → theo mục MỚI NHẤT, changeNote 'Trước đây <người> dạy khác (<dd/mm>)'. Tài liệu (có ghi (cập nhật YYYY-MM-DD)) và mục ĐÃ DUYỆT mâu thuẫn → theo bên NGÀY MỚI HƠN; CÙNG ngày → theo mục đã duyệt. Điền changeNote ngắn về bên bị bỏ qua.",
    "- Khối [CHƯA DUYỆT] chỉ xuất hiện khi chưa có tài liệu nào khớp → được dùng làm các bước (source taught).",
    "- ĐÍNH CHÍNH MỘT PHẦN: mục team dạy có dòng 'Sửa cho: WFxx' (kèm các cặp Cũ/Mới), HOẶC chỉ nêu vài chi tiết (version, link, tên người/team, tên nút...) của WFxx đang khớp mà không phải cả cách xử lý → vẫn trả lời ĐỦ các bước, nhánh, escalate của WFxx, chỉ thay đúng chi tiết đó (đoạn Cũ → Mới); source \"kb\", sourceRef WFxx, patched = true, changeNote 'Cập nhật: <cũ ngắn> → <mới ngắn>'. TUYỆT ĐỐI không rút WF còn 1-2 bước chỉ vì mục dạy ngắn. Nếu WFxx có (cập nhật ...) MỚI HƠN mục dạy → WF đã gộp bản sửa rồi, theo WF, patched = false.",
    "- Chỉ lấy các bước từ [team đã dạy] (source taught) khi mục dạy là cách xử lý ĐẦY ĐỦ, khác cách làm của WFxx, hoặc chưa có WFxx.",
    "- Kiến thức có ghi '(CHƯA VERIFY)' → đặt unverified = true.",
    "",
    "TRẢ LỜI SAU KHI HỎI LẠI: HỘI THOẠI GẦN ĐÂY có câu bot hỏi lại (dòng có ❓ và các lựa chọn •) và tin mới là câu trả lời cho nó ('có rồi', 'chưa', 'bản cũ'...) → CHỈ đưa các bước của ĐÚNG nhánh đó (kèm bước kiểm tra tiếp theo trong nhánh), KHÔNG liệt kê lại các nhánh khác.",
    "HỎI LẠI ĐỂ CHẨN ĐOÁN (dạng 4): chỉ dùng khi ĐỦ cả 3: (a) workflow khớp có ≥ 2 nhánh xử lý KHÁC HẲN nhau theo 1 điều kiện (vd đã lên server chưa, version cũ hay mới); (b) câu hỏi + HỘI THOẠI GẦN ĐÂY chưa cho biết điều kiện đó; (c) trong đoạn đang chat bot CHƯA hỏi lại lần nào. Người hỏi đã nói rõ điều kiện, muốn xem hết ('xem hết', 'đủ các bước', 'tổng quát'), hoặc bot vừa hỏi lại rồi → trả lời dạng 1 bình thường.",
    "ĐẦU RA: CHỈ trả về 1 object JSON (không kèm chữ nào khác, không ```), theo 1 trong 4 dạng:",
    '1) Có workflow khớp: {"kind":"workflow","title":"<vấn đề, tối đa 8 từ>","intro":"<1 câu chào + dẫn vào, vd: Chào An, xử lý theo các bước:>","steps":["<mỗi bước 1 hành động ngắn>",...],"escalate":"<ai> khi <điều kiện>, KHÔNG ghi chữ Escalate ở đầu. CHỈ điền khi nguồn có nêu đầu mối escalate, không có thì để rỗng, TUYỆT ĐỐI không tự chế","source":"kb" hoặc "taught","sourceRef":"<vd WF12, tên file tài liệu; rỗng nếu taught>","patched":true/false,"unverified":true/false,"changeNote":"<rỗng nếu không có thay đổi>"}',
    '   source = "taught" nếu các bước lấy từ khối [team đã dạy], "kb" nếu từ [tài liệu L1]/[tài liệu chuyên sâu].',
    '2) Nghiệp vụ nhưng CHƯA CÓ: {"kind":"missing"}',
    '3) Tiếng Anh / hỏi chung / tán gẫu / tiếp nhận thông tin: {"kind":"other","text":"<câu trả lời tự nhiên, văn bản thuần, xuống dòng và gạch đầu dòng - nếu cần>"}',
    '4) Cần hỏi lại 1 câu để chọn nhánh: {"kind":"clarify","title":"<vấn đề, tối đa 8 từ>","check":"<việc cần kiểm tra trước, 1 câu, lấy từ nguồn>","question":"<1 câu hỏi ngắn về điều kiện rẽ nhánh>","options":[{"answer":"<câu trả lời ngắn, vd Chưa có>","next":"<nhánh xử lý tương ứng, ≤ 12 từ, lấy từ nguồn>"},...],"sourceRef":"<WFxx hoặc tên tài liệu; rỗng nếu từ kiến thức team dạy>"}',
    "",
    "Vai (B) - tiếng Anh:",
    "- Khi được hỏi về tiếng Anh (dịch câu/từ, giải nghĩa, cách phát âm, phiên âm, ngữ pháp, đặt câu ví dụ), trả lời TRỰC TIẾP bằng kiến thức chung — KHÔNG cần và KHÔNG viện dẫn tài liệu/bộ nhớ nội bộ.",
    "- Hỏi phát âm 1 từ: cho phiên âm IPA, cách đọc mô phỏng theo âm tiếng Việt, và 1 ví dụ đặt câu ngắn.",
    "- Dịch: cho bản dịch tự nhiên, nếu có từ khó thì chú thích thêm.",
    "- Đây là dữ liệu học tập công khai, không phải chuyện nội bộ, nên cứ trả lời thoải mái.",
    "",
    "Với mỗi câu hỏi nghiệp vụ, phần WORKFLOW LIÊN QUAN (đã lọc khớp nhất) sẽ được cung cấp ngay trong prompt. Chỉ dựa vào đó.",
    "Nhắc lại: đầu ra LUÔN là 1 object JSON duy nhất.",
  ].join("\n");

  async function logUsage(entry) {
    if (!usageLogPath) return;
    try {
      await appendFile(usageLogPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch (err) {
      console.error("[usage] khong ghi duoc log:", err.message);
    }
  }

  function describeCodes(codes) {
    return codes.map((c) => {
      const info = directory.get(c);
      return info ? `${c} = ${info.label}` : c;
    });
  }

  async function save(kind, { userId, userName, body, question, auto, gap, context }) {
    const codes = extractCodes(question ? `${question} ${body}` : body);
    const entry = stamp(userName, body, codes);
    const writes = [];
    const replies = [];

    if (kind === "handover") {
      writes.push(memory.remember(ns.handover, entry));
      for (const c of codes) writes.push(memory.remember(ns.customer(c), entry));
      replies.push(
        `Đã ghi bàn giao ca${codes.length ? ` (liên quan: ${codes.join(", ")})` : ""}. Ca sau hỏi "ca trước bàn giao gì?" là thấy.`
      );
    } else if (kind === "log") {
      writes.push(memory.remember(ns.caselog, entry));
      for (const c of codes) writes.push(memory.remember(ns.customer(c), entry));
      replies.push(
        codes.length
          ? `Đã lưu lịch sử cho ${codes.join(", ")}. Lần sau ai nghe máy hỏi "${codes[0]} có lịch sử gì?" là thấy.`
          : "Đã lưu, nhưng không thấy mã SR-/OUT-/NPP- nên chưa gắn được vào lịch sử khách. Lần sau ghi kèm mã nhé."
      );
    } else if (kind === "teach") {
      // Luu CAP "tinh huong + cach xu ly" de lan sau vector search khop theo tinh huong.
      // Gemini chuan hoa truoc (buoc gon, escalate chi khi duoc bao, patch WF); loi day goc
      // van giu nguyen van ben duoi de Ha doi chieu khi duyet thu 6.
      const t = await prepareTeach({ question, body, gap, context });
      const unverified = t ? t.unverified : UNVERIFIED_RE.test(body);
      const situation = t?.situation || question || "";
      const content = t
        ? [
            situation ? `Câu hỏi/tình huống: ${situation}` : "",
            t.steps.length ? `Cách xử lý:\n${t.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
            t.escalate ? `Escalate: ${t.escalate}` : "",
            t.note ? `Ghi chú: ${t.note}` : "",
            `Lời dạy gốc: ${body}`,
            // Ghi ro WF + doan cu/moi: luc tra loi bot giu du cac buoc WF, chi thay doan nay;
            // job review thu 6 hien thanh ban sua cu -> moi de Ha duyet roi merge vao file WF.
            ...(t.patch ? [`Sửa cho: ${t.patch.ref} (chỉ sửa ý này, các bước khác giữ nguyên)`, ...t.patch.edits.map((e) => `Cũ: ${e.old}\nMới: ${e.new}`)] : []),
          ].filter(Boolean).join("\n")
        : question
          ? `Câu hỏi/tình huống: ${question}\nCách xử lý: ${body}`
          : body;
      // CUNG 1 moc gio cho ban Walrus + addendum (khoa "nguoi day|gio" cua kb-merged.json).
      const now = new Date();
      const when = nowStamp(now);
      writes.push(memory.remember(ns.knowledge, stamp(userName, `${unverified ? `${UNVERIFIED_TAG} ` : ""}${content}`, codes, now)));
      await appendAddendum(userName, unverified ? `${content}\n${UNVERIFIED_TAG}` : content, when);
      replies.push(fmtTaught({ question: situation, body, t, unverified, userName, when, auto }));
    } else if (kind === "note") {
      writes.push(memory.remember(ns.personal(userId), entry));
      replies.push("Đã ghi nhớ riêng cho bạn.");
    }

    await Promise.all(writes); // cho relayer nhan job; index tren Walrus chay nen

    if (kind === "log") {
      const alert = await incident.check({ body, codes, author: userName }).catch((err) => {
        console.error("[incident] loi:", err.message);
        return null;
      });
      if (alert) replies.push(alert);
    }

    await logUsage({ kind, user: userName, codes, writes: writes.length, text: body, replies });
    return replies;
  }

  // Relayer Walrus doi luc cham/loi (502, 504 RECALL_TIMEOUT o buoc seal_decrypt).
  // Moi lan tim: gioi han 9s (khong de 1 kho cham giu ca cau tra loi), loi nhanh
  // thi thu lai 1 lan. Loi thi GHI LOG va bao ra ngoai - khong coi nhu "khong co gi".
  async function safeRecall(namespace, query, opts) {
    for (let attempt = 1; ; attempt++) {
      let timer;
      try {
        return await Promise.race([
          memory.recall(namespace, query, opts),
          new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${RECALL_TIMEOUT_MS / 1000}s`)), RECALL_TIMEOUT_MS))),
        ]);
      } catch (err) {
        console.warn(`[recall] ${namespace} lan ${attempt} loi: ${err.status || ""} ${String(err.message).slice(0, 90)}`);
        if (attempt >= 2 || /timeout/.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // HOI LAI DE CHAN DOAN: ban nhap co >= 2 nhanh "Neu ..." -> Gemini quyet co nen hoi 1 cau
  // truoc (nguoi hoi dang xu ly 1 case cu the ma chua noi dieu kien chon nhanh) hay tra het.
  // Model lite tu no gan nhu khong bao gio chon hoi lai (test 27/09) nen tach thanh buoc rieng.
  const SEE_ALL_RE = /xem\s*h[eế]t|[dđ][uủ]\s*(?:c[aá]c\s*)?b[uư][oớ]c|t[aấ]t\s*c[aả]|to[aà]n\s*b[oộ]|t[oổ]ng\s*qu[aá]t|full/i;
  async function maybeClarify({ question, context, steps }) {
    const branches = (steps.join("\n").match(/(?:^|[\s(:;.])(?:n[eế]u|tr[uư][oờ]ng\s*h[oợ]p)\s/gi) || []).length;
    if (branches < 2 || SEE_ALL_RE.test(question) || /❓/.test(context || "")) return null;
    const r = parseJson(
      await ask({
        system: [
          "Bot support L1 vừa soạn câu trả lời có nhiều nhánh xử lý. Quyết định có nên HỎI LẠI 1 câu trước khi trả lời hết không. Chỉ trả về 1 object JSON:",
          '{"ask":true/false,"title":"<vấn đề, ≤ 8 từ>","check":"<việc cần kiểm tra trước, 1 câu, lấy từ bản nháp>","question":"<1 câu hỏi ngắn về điều kiện rẽ nhánh>","options":[{"answer":"<trả lời ngắn>","next":"<nhánh tương ứng, ≤ 12 từ, lấy từ bản nháp>"},...]}',
          "- ask=true khi người hỏi đang xử lý 1 CASE CỤ THỂ (vd 'SR báo...', 'user phản ánh...') mà câu hỏi và hội thoại CHƯA cho biết điều kiện để chọn nhánh.",
          "- ask=false khi người hỏi tra cứu chung/muốn biết cả quy trình, đã nói rõ điều kiện, hoặc các nhánh chỉ là chi tiết nhỏ.",
          "- options: 2-3 lựa chọn, bám đúng các nhánh trong bản nháp, không thêm thông tin mới.",
        ].join("\n"),
        prompt: `${context ? `HỘI THOẠI GẦN ĐÂY:\n${context}\n\n` : ""}CÂU HỎI: ${question}\n\nBẢN NHÁP:\n${steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}`,
      }).catch(() => "")
    );
    return r?.ask && r.question && Array.isArray(r.options) && r.options.length >= 2 ? r : null;
  }

  async function altQuery(question, context, tried) {
    const out = await ask({
      system: [
        "Câu hỏi dưới đây tra kho tài liệu support app bán hàng (FieldGo, DMS, Cooler Audit, Workflow, E-Contract...) KHÔNG ra kết quả.",
        "Viết lại 1 câu tìm kiếm KHÁC, dùng thuật ngữ hay gặp trong tài liệu (vd 'tủ lạnh/verify tủ' → 'Cooler Audit', 'mất tuyến/đơn không có tuyến' → 'Null Route RouteID', 'không đồng bộ' → 'delta sync', 'đơn' → 'order'), nêu rõ hệ thống/app.",
        "Chỉ trả về đúng 1 câu, không giải thích. Câu hỏi không phải về hệ thống nội bộ → trả về chữ NONE.",
      ].join("\n"),
      prompt: `${context ? `Hội thoại gần đây:\n${context}\n\n` : ""}Câu hỏi: ${question}\nĐã tra bằng: ${tried}`,
    }).catch(() => "");
    const alt = String(out).split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").trim();
    return alt && alt !== "NONE" && alt.toLowerCase() !== String(tried).toLowerCase() ? alt : "";
  }

  const isApproved = (h) => APPROVER_RE.test(h?.meta?.author || "");
  // LOI DAY DA GOP VAO WF (kb-merged.json, Claude ghi khi gop + sync-kb day len): bot bo qua,
  // dung WF (ban day du hon). Vd 28/09 Cooler Movement: loi day goc thieu dieu kien "delta sync
  // xong, het pending moi xoa du lieu" ma WF37 da co -> bot van chep theo loi day goc (29/09).
  let mergedCache = { mtime: -1, keys: new Set() };
  async function mergedKeys() {
    if (!mergedPath) return mergedCache.keys;
    try {
      const st = await stat(mergedPath);
      if (st.mtimeMs !== mergedCache.mtime) {
        const items = JSON.parse(await readFile(mergedPath, "utf8")).items || [];
        // Ban Walrus + addendum truoc 30/09 lay gio rieng -> co the lech 1 phut: nhan ca +-1 phut.
        const keys = new Set();
        for (const x of items) {
          const t = new Date(`${String(x.at).replace(" ", "T")}:00+07:00`).getTime();
          for (const d of [-60000, 0, 60000]) if (!isNaN(t)) keys.add(`${x.by}|${ymdVN.format(t + d)} ${hhmm(t + d)}`);
        }
        mergedCache = { mtime: st.mtimeMs, keys };
      }
    } catch {
      // chua co file -> khong bo loi day nao
    }
    return mergedCache.keys;
  }
  const taughtKey = (h) => (h?.meta?.time ? `${h.meta.author}|${ymdVN.format(h.meta.time)} ${hhmm(h.meta.time)}` : "");

  async function answer({ chatId, userId, userName, question, context, searchQuery, retried = false }) {
    // Tra kho bang cau da viet lai du nghia (cau noi tiep "vay buoc 2 nang len ban nao" khong
    // co chu "Cooler Audit" -> tra truot, bao "chua co" - test 27/09). LLM van doc cau goc.
    const sq = searchQuery && searchQuery !== question ? searchQuery : question;
    const codes = extractCodes(question);
    const wantsHandover = HANDOVER_Q.test(question);

    // RAG: chi keo ve workflow LIEN QUAN nhat (khong nhoi ca file) - base tu kb,
    // cong workflow team da day. Neu khong co gi du gan -> block trong -> "chua co".
    const kbNs = await kbNamespaces();
    // Quy trinh chuan WFxx nam kho RIENG (kbwf) -> luon co cho, khong bi cac mau ghi
    // chu na na nhau chiem het top-k (ca 25/09 WF44 bi day ra ngoai top 8).
    const docSources = [
      ...(kbNs.kbwf
        ? [{ label: "quy trình chuẩn WFxx", taught: false, p: safeRecall(kbNs.kbwf, sq, { limit: 5, maxDistance: 0.6 }).then((h) => localKb.filterLive(kbNs.kbwf, h)).then((h) => h.slice(0, 3)), fb: () => localKb.searchKb(kbNs.kbwf, sq, 3) }]
        : []),
      { label: "tài liệu L1", taught: false, p: safeRecall(kbNs.kb, sq, { limit: 10, maxDistance: 0.55 }).then((h) => localKb.filterLive(kbNs.kb, h)).then((h) => diversify(h)), fb: () => localKb.searchKb(kbNs.kb, sq, 8).then((h) => h && diversify(h)) },
      ...(includePrivateKb
        ? [{ label: "tài liệu chuyên sâu", taught: false, p: safeRecall(kbNs.kbpriv, sq, { limit: 8, maxDistance: 0.55 }).then((h) => localKb.filterLive(kbNs.kbpriv, h)).then((h) => diversify(h, { perSource: 2, max: 5 })), fb: () => localKb.searchKb(kbNs.kbpriv, sq, 6).then((h) => h && diversify(h, { perSource: 2, max: 5 })) }]
        : []),
      { label: "team đã dạy (xếp MỚI → CŨ)", taught: true, p: safeRecall(ns.knowledge, sq, { limit: 4, maxDistance: 0.5 }), fb: () => localKb.searchTaught(sq, 4) },
    ];
    const memSources = [
      // contextOnly: chi de hieu ngu canh, KHONG du lam can cu tra loi quy trinh.
      { label: "Ghi nhớ tự động", contextOnly: true, p: safeRecall(autoNs, sq, { limit: 4, maxDistance: 0.5 }) },
      { label: "Trao đổi trước đây trong nhóm này", contextOnly: true, p: safeRecall(chatNs(chatId), sq, { limit: 3, maxDistance: 0.5 }) },
      { label: `Ghi nhớ riêng của ${userName}`, p: safeRecall(ns.personal(userId), sq, { limit: 3, maxDistance: 0.55 }) },
      wantsHandover
        ? { label: "Bàn giao ca (24h qua)", recentOnly: true, p: safeRecall(ns.handover, "bàn giao ca, case đang mở, việc đã hứa", { limit: 10, sort: "recent" }) }
        : { label: "Bàn giao ca", p: safeRecall(ns.handover, sq, { limit: 3, maxDistance: 0.45 }) },
      ...codes.map((c) => ({ label: `Lịch sử ${c}`, p: safeRecall(ns.customer(c), c, { limit: 10, sort: "recent" }) })),
    ];

    const [docSettled, memSettled] = await Promise.all([
      Promise.allSettled(docSources.map((s) => s.p)),
      Promise.allSettled(memSources.map((s) => s.p)),
    ]);

    // Ngay cap nhat theo TUNG MAU (khong theo ngay sua ca file).
    for (let i = 0; i < docSettled.length; i++) {
      if (!docSources[i].taught && docSettled[i].status === "fulfilled") {
        docSettled[i] = { ...docSettled[i], value: await localKb.fixDates(docSettled[i].value).catch(() => docSettled[i].value) };
      }
    }

    // Walrus loi/cham -> tra kho du phong tren dia (cung noi dung da nap). Khong co
    // file du phong thi giu "rejected" -> bao that la chua tra duoc.
    let usedFallback = false;
    for (let i = 0; i < docSettled.length; i++) {
      if (docSettled[i].status !== "rejected" || !docSources[i].fb) continue;
      let hits = await docSources[i].fb().catch(() => null);
      if (hits && !docSources[i].taught) hits = await localKb.fixDates(hits).catch(() => hits);
      if (hits) {
        docSettled[i] = { status: "fulfilled", value: hits, fallback: true };
        usedFallback = true;
      }
    }
    // Vua "day:" xong (<15 phut) co the Walrus chua index kip -> bo sung tu addendum.
    const ti = docSources.findIndex((x) => x.taught);
    if (ti >= 0 && docSettled[ti].status === "fulfilled" && !docSettled[ti].fallback) {
      const recent = ((await localKb.searchTaught(sq, 4).catch(() => null)) || []).filter(
        (h) => h.meta && Date.now() - h.meta.time.getTime() < RECENT_TAUGHT_MS
      );
      const have = new Set(docSettled[ti].value.map((h) => bodyKey(h.text)));
      for (const h of recent) if (!have.has(bodyKey(h.text))) docSettled[ti].value.push(h);
    }

    // Loi day da gop vao WF -> bo (dung WF).
    const merged = await mergedKeys();
    let mergedSkipped = 0;
    if (ti >= 0 && docSettled[ti].status === "fulfilled" && merged.size) {
      const before = docSettled[ti].value.length;
      docSettled[ti].value = docSettled[ti].value.filter((h) => !merged.has(taughtKey(h)));
      mergedSkipped = before - docSettled[ti].value.length;
    }

    // Kien thuc day: xep MOI -> CU de LLM (va nhan nguon) uu tien ban moi nhat.
    docSettled.forEach((r, i) => {
      if (docSources[i].taught && r.status === "fulfilled") {
        r.value.sort((a, b) => (b.meta?.time?.getTime() || 0) - (a.meta?.time?.getTime() || 0));
      }
    });

    // LOG NGUON: moi cau tra loi ghi lai tung mau da dua cho Gemini (kho, blob, khoang cach, ngay,
    // ai day, da duyet chua) -> debug "sao bot noi v5.9.0" bang cach xem usage.jsonl.
    const provenance = [];
    docSettled.forEach((r, i) => {
      if (r.status !== "fulfilled") return provenance.push({ from: docSources[i].label, error: String(r.reason?.message || r.reason).slice(0, 60) });
      for (const h of r.value)
        provenance.push({
          from: docSources[i].label,
          ns: h.namespace || "",
          blob: h.blob_id || "",
          d: typeof h.distance === "number" ? +h.distance.toFixed(3) : undefined,
          day: /\(cập nhật (\d{4}-\d{2}-\d{2})\)/.exec(h.text)?.[1] || (h.meta?.time ? ymdVN.format(h.meta.time) : ""),
          by: h.meta?.author,
          approved: docSources[i].taught ? isApproved(h) : undefined,
          fallback: r.fallback || undefined,
          head: String(h.text).replace(/^\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?/, "").slice(0, 60),
        });
    });
    // PHUONG AN B do CODE quyet (Gemini khong nghe luat "chua duyet thi khong ap dung" - test
    // 27/09): da co tai lieu/WF -> cau day CHUA DUYET khong dua vao soan cau tra loi, chi hien
    // dong canh bao vang. Chua co tai lieu nao -> van dung cau day do (ghi "chua duyet").
    const hasDocs = docSettled.some((r, i) => !docSources[i].taught && r.status === "fulfilled" && r.value.length);
    let pendingHits = [];
    if (hasDocs && ti >= 0 && docSettled[ti].status === "fulfilled") {
      pendingHits = docSettled[ti].value.filter((h) => !isApproved(h) && !(h.distance > 0.45));
      docSettled[ti].value = docSettled[ti].value.filter(isApproved);
    }
    const pendingNote = pendingHits
      .slice(0, 2)
      .map((h) => {
        const t = String(h.text);
        const what = /^Mới: (.+)$/m.exec(t)?.[1] || /Cách xử lý:\s*([\s\S]+?)(?:\nLời dạy gốc:|\nSửa cho:|\nEscalate:|\nGhi chú:|$)/.exec(t)?.[1] || t.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*/, "");
        return `${h.meta?.author || "team"} dạy ${h.meta?.time ? shortDate(h.meta.time) : ""}: ${what.replace(/\s+/g, " ").trim().slice(0, 140)}`;
      })
      .join(" · ");
    let sourceLabel = "";
    const docBlocks = [];
    const stats = [];
    docSettled.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value.length) return;
      if (docSources[i].taught) {
        const ok = r.value.filter(isApproved);
        const pending = r.value.filter((h) => !isApproved(h));
        if (ok.length) docBlocks.push(`[team đã dạy — ĐÃ DUYỆT (Ha), xếp MỚI → CŨ]\n${ok.map((h) => h.text).join("\n\n")}`);
        if (pending.length) docBlocks.push(`[team đã dạy — CHƯA DUYỆT, xếp MỚI → CŨ]\n${pending.map((h) => h.text).join("\n\n")}`);
        stats.push(`${r.value.length} ${docSources[i].label}`);
        return;
      }
      docBlocks.push(`[${docSources[i].label}]\n${r.value.map((h) => h.text).join("\n\n")}`);
    });

    const memBlocks = [];
    memSettled.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      let hits = r.value;
      if (memSources[i].recentOnly) hits = hits.filter((h) => !h.meta || Date.now() - h.meta.time.getTime() < DAY_MS);
      // Ky uc co han (case/loi hen) qua han thi bo, tranh thanh rac sau vai ngay.
      const today = ymdVN.format(Date.now());
      hits = hits.filter((h) => !(/hết hạn (\d{4}-\d{2}-\d{2})/.exec(h.text)?.[1] < today));
      if (!hits.length) return;
      memBlocks.push(`[${memSources[i].label}]\n${hits.map((h) => `- ${h.text}`).join("\n")}`);
      stats.push(`${hits.length} ${memSources[i].label.toLowerCase()}`);
    });

    const prompt = [
      `Người hỏi: ${userName}`,
      `Thời điểm: ${nowStamp()} (giờ VN)`,
      codes.length ? `Mã được nhắc tới: ${describeCodes(codes).join("; ")}` : "",
      "",
      "HỘI THOẠI GẦN ĐÂY (để hiểu ngữ cảnh):",
      context || "(không có)",
      "",
      "WORKFLOW LIÊN QUAN (đã lọc khớp nhất; nếu TRỐNG hoặc chỉ có workflow khác vấn đề → coi như chưa có, đừng bịa):",
      docBlocks.length ? docBlocks.join("\n\n") : "(không có)",
      "",
      "BỘ NHỚ LIÊN QUAN (lịch sử/ghi nhớ):",
      memBlocks.length ? memBlocks.join("\n\n") : "(không có)",
      "",
      `CÂU HỎI: ${question}`,
      // Cau ngan tra loi bot ("chua co", "ban cu") -> kem y day du router da hieu tu hoi thoai.
      sq !== question ? `Ý ĐẦY ĐỦ (đã hiểu theo hội thoại): ${sq}` : "",
    ].join("\n");

    const raw = await ask({ system, prompt });
    if (question.length >= 12 && !retried) memory.analyze(autoNs, `${userName}: ${question}`);

    const hitsOf = (pred) =>
      docSettled.flatMap((r, i) => (pred(docSources[i]) && r.status === "fulfilled" ? r.value : []));
    const kbHits = hitsOf((s) => !s.taught);
    const taughtHits = hitsOf((s) => s.taught);
    const anyMemory = memSettled.some((x, i) => !memSources[i].contextOnly && x.status === "fulfilled" && x.value.length);

    let r = parseJson(raw);
    // Lite doi khi bao "chua co" / tra loi kieu tan gau du tai lieu CO dap an (test dem 28/09: A6
    // link team BI 1/3 lan "chua co"; C2 "xoa du lieu app" tra loi nguoc WF1) -> hoi lai model manh 1 lan.
    // Chi ton them ~vai chuc giay o cac cau nay, cau binh thuong khong doi.
    let secondOpinion;
    if (!retried && kbHits.length + taughtHits.length && (r?.kind === "missing" || (r?.kind === "other" && SYSTEM_RE.test(sq)))) {
      const r2 = parseJson(await askStrong({ system, prompt }).catch(() => ""));
      if (r2?.kind) {
        secondOpinion = `${r.kind}→${r2.kind}`;
        r = r2;
      }
    }
    // Nhan nguon LLM tu ghi (vd "WF01") ma khong co trong cac mau tim duoc -> bo, de code tu gan.
    if (r?.sourceRef && !docBlocks.join("\n").includes(String(r.sourceRef).replace(/\.md$/, ""))) r.sourceRef = "";
    let reply;
    let kind = r?.kind || "raw";
    // Chong bia: LLM bao "co workflow" ma khong co mau tai lieu/bo nho nao -> chua co.
    if (kind === "workflow" && !kbHits.length && !taughtHits.length && !anyMemory) kind = "missing";
    if (kind === "other" && SYSTEM_RE.test(question) && QUESTION_WORDS.test(question) && !kbHits.length && !taughtHits.length) kind = "missing";
    // Chong bia link: URL trong cau tra loi ma khong co trong nguon/cau hoi/hoi thoai -> coi nhu chua co.
    const known = [question, context, ...docBlocks, ...memBlocks].join("\n");
    const answerText = r ? [r.text, r.title, r.intro, ...(Array.isArray(r.steps) ? r.steps : []), r.escalate].join("\n") : raw;
    const urls = answerText.match(URL_RE) || [];
    if ((kind === "other" || kind === "workflow") && urls.some((u) => !known.includes(u.replace(/[.,!?)\]]+$/, "")))) kind = "missing";
    // Kho tai lieu/kien thuc day bi loi (khong phai "khong co") -> noi that, khong bao "chua co".
    const recallFailed = docSettled.some((x) => x.status === "rejected");
    const walrusDown = recallFailed || usedFallback;
    if (walrusDown && !kbHits.length && !taughtHits.length && kind !== "other") kind = "degraded";
    // Walrus loi -> ban du phong tra theo tu khoa kem hon tra theo nghia: "chua co" luc nay
    // CHUA chac dung -> bao that la chua tra du, khong moi day/khong ghi cau hoi cho.
    if (walrusDown && kind === "missing") kind = "degraded";
    if (walrusDown && kind === "other" && SYSTEM_RE.test(question) && !kbHits.length && !taughtHits.length) kind = "degraded";

    if (kind === "degraded") {
      reply = usedFallback
        ? "{yellow}⚠️ Bộ nhớ Walrus đang chậm/lỗi. Mình đã tra bản dự phòng nhưng chưa thấy nội dung khớp đúng vấn đề.{/yellow}\nBạn hỏi lại sau ít phút để mình tra đầy đủ nhé."
        : "{yellow}⚠️ Bộ nhớ Walrus đang phản hồi chậm/lỗi nên mình chưa tra được kho kiến thức.{/yellow}\nBạn hỏi lại sau ít phút nhé.";
    }
    if (kind === "workflow" && Array.isArray(r.steps)) {
      const c = await maybeClarify({ question, context, steps: r.steps });
      if (c) {
        r.kind = kind = "clarify";
        Object.assign(r, { title: c.title || r.title, check: c.check, question: c.question, options: c.options });
      }
    }
    if (kind === "clarify") {
      // Hoi 1 cau de chi dua dung nhanh. Cau tra loi ("co roi"/"chua") nam trong doan dang chat
      // -> lan sau router viet lai thanh cau day du va bot tra loi dung nhanh.
      if (!r.question || !Array.isArray(r.options) || r.options.length < 2 || (!kbHits.length && !taughtHits.length)) kind = "missing";
      else {
        reply = fmtClarify({ title: r.title, check: r.check, question: r.question, options: r.options, source: r.sourceRef ? `📚 ${r.sourceRef}` : taughtHits.length ? "👥 team đã dạy" : "📚 tài liệu L1" });
        addGap(chatId, question, "answered", { ref: /^WF\d+$/.test(r.sourceRef || "") ? r.sourceRef : "", summary: `(bot hỏi lại) ${r.question}` });
      }
    }
    // Sap bao "chua co" -> tu tra lai 1 lan bang cach dien dat khac (thuat ngu trong tai lieu:
    // "tu lanh" -> Cooler Audit, "mat tuyen" -> Null Route...). Walrus loi thi da la degraded.
    if (kind === "missing" && !retried) {
      const alt = await altQuery(question, context, sq);
      if (alt) return answer({ chatId, userId, userName, question, context, searchQuery: alt, retried: true });
    }
    if (kind === "missing") {
      reply = fmtMissing(question);
      addGap(chatId, question, "missing");
    } else if (kind === "workflow") {
      let source = "";
      // Nhan nguon: uu tien muc da duyet; muc chua duyet thi ghi ro "chua duyet".
      const top = taughtHits.find(isApproved) || taughtHits[0];
      const taughtLabel = top?.meta ? `${top.meta.author} dạy ${shortDate(top.meta.time)}${isApproved(top) ? "" : " · chưa duyệt"}` : "team đã dạy";
      // Nhan nguon theo luat "ben moi hon thang" (khong phu thuoc LLM tu gan nhan): tai lieu
      // cap nhat cung ngay/sau lan day gan nhat -> ghi nguon la tai lieu (WFxx).
      const docDay = (h) => /\(cập nhật (\d{4}-\d{2}-\d{2})\)/.exec(h.text)?.[1];
      const taughtDay = top?.meta?.time ? ymdVN.format(top.meta.time) : "";
      const wfHits = hitsOf((x) => x.label.startsWith("quy trình chuẩn"));
      const newerDoc = [...wfHits, ...kbHits].find((h) => docDay(h) && taughtDay && docDay(h) > taughtDay);
      // Dinh chinh 1 phan: cac buoc van la WF, chi 1 chi tiet lay tu ban day -> ghi ca 2.
      const patchHit = r.patched && (taughtHits.find((h) => r.sourceRef && h.text.includes(`Sửa cho: ${r.sourceRef}`)) || top);
      const patchLabel = patchHit?.meta ? `${patchHit.meta.author} dạy ${shortDate(patchHit.meta.time)}` : taughtLabel;
      if (patchHit && !newerDoc) source = `📚 ${r.sourceRef || "tài liệu L1"} · cập nhật: ${patchLabel}`;
      else if (r.source === "taught" && top && newerDoc) source = `📚 ${sourceKey(newerDoc.text)}`;
      else if (r.source === "taught" && top) source = `👥 ${taughtLabel}`;
      else if (kbHits.length) source = `📚 ${r.sourceRef || "tài liệu L1"}`;
      else if (top) source = `👥 ${taughtLabel}`;
      else source = "🧠 bộ nhớ nhóm";
      if (usedFallback) source += " (bản dự phòng)";
      const unverified =
        !!r.unverified ||
        (r.source === "taught" && !!top?.text?.includes(UNVERIFIED_TAG)) ||
        (!!patchHit && !newerDoc && !!patchHit.text?.includes(UNVERIFIED_TAG));
      reply = fmtWorkflow({
        title: r.title,
        intro: r.intro,
        steps: Array.isArray(r.steps) ? r.steps : [],
        // "Khong can escalate" -> bo dong escalate (dong mau cam chi de chi DAU MOI can chuyen)
        escalate: /^\s*(?:không|khong|ko)\b/i.test(String(r.escalate || "").replace(/^\s*escalate\s*:?\s*/i, ""))
          ? ""
          : String(r.escalate || "").replace(/^\s*escalate\s*:?\s*/i, ""),
        unverified,
        source,
        changeNote: String(r.changeNote || "").slice(0, 160),
        pendingNote,
      });
      sourceLabel = source;
      addGap(chatId, question, "answered", {
        ref: /^WF\d+$/.test(r.sourceRef || "") ? r.sourceRef : "",
        summary: (Array.isArray(r.steps) ? r.steps : []).join(" / ").slice(0, 800),
      });
    } else if (kind !== "degraded" && kind !== "clarify") {
      reply = md(r?.text || looseText(raw) || raw);
    }

    await logUsage({ kind: "question", user: userName, codes, memoryHits: stats, answer: kind, text: question, searchQuery: sq !== question ? sq : undefined, secondOpinion, mergedSkipped: mergedSkipped || undefined, source: sourceLabel || undefined, provenance, reply });
    return [reply];
  }

  async function weather(input, context) {
    try {
      // 1 lan goi LLM: (a) co THAT la hoi thoi tiet khong (tranh "ngao a, hoi thoi tiet
      // hoai" bi tra thoi tiet lan nua), (b) dia danh -> ten tra duoc cap phuong + toa do
      // gan dung (VN bo cap quan tu 7/2025: "Quan 9" cu nay la cac phuong Tang Nhon Phu,
      // Long Phuoc, Phuoc Long...).
      const plan = parseJson(
        await ask({
          system: [
            "Bạn phân tích câu hỏi thời tiết ở Việt Nam. Chỉ trả về 1 object JSON:",
            '{"weather":true/false,"query":"<tên tra bản đồ, càng chi tiết càng tốt: Phường X, Thành phố Y>","label":"<tên hiển thị, giữ cách user gọi, vd Quận 9 (cũ)>","lat":<số>,"lon":<số>,"days":<0 nếu hỏi hiện tại/hôm nay/mấy giờ tới, số ngày nếu hỏi mấy ngày tới>}',
            "- weather=false nếu tin nhắn KHÔNG hỏi thời tiết (chê bot, cảm thán, hỏi chuyện khác dù có chữ mưa/nắng/thời tiết).",
            "- Từ 7/2025 VN bỏ cấp quận/huyện: tên quận/huyện cũ → đổi sang 1 phường/xã hiện tại nằm ở trung tâm khu vực đó cho 'query'; lat/lon là tọa độ gần đúng trung tâm khu vực user hỏi.",
            "- Tin nhắn không nêu địa danh → dùng địa danh trong hội thoại gần đây; không có nữa thì Thành phố Hồ Chí Minh.",
          ].join("\n"),
          prompt: `Hội thoại gần đây:\n${context || "(không có)"}\n\nTin nhắn: ${input}`,
        })
      );
      if (!plan || plan.weather === false) return null; // khong phai hoi thoi tiet -> tra loi binh thuong

      const loc = await geocode({ query: plan.query, label: plan.label, lat: Number(plan.lat), lon: Number(plan.lon) });
      if (!loc) return [`Chưa xác định được vị trí "${md(plan.label || plan.query || input)}". Ghi rõ tên phường/xã hoặc quận cũ + thành phố giúp mình nhé.`];
      const data = await getWeatherAt(loc, { days: Number(plan.days) || 0 });
      if (!data) return ["Chưa lấy được số liệu thời tiết (nguồn Open-Meteo đang lỗi), thử lại sau nhé."];

      const where = plan.label && plan.label !== loc.name ? `${plan.label} (${loc.name})` : loc.name;
      const text = await ask({
        system: [
          "Bạn trả lời câu hỏi thời tiết DỰA HOÀN TOÀN vào số liệu cho sẵn. Tiếng Việt, ngắn gọn, văn bản thuần.",
          "- Trả lời THẲNG vào đúng điều được hỏi (vd hỏi 'còn mưa không' → nói có/không trước, rồi tới khi nào tạnh/mưa tiếp theo số liệu 15 phút & từng giờ).",
          "- Câu đầu nêu khu vực + giờ số liệu. Chỉ liệt kê theo ngày khi user hỏi nhiều ngày.",
          "- Không bịa số liệu ngoài dữ liệu cho sẵn.",
        ].join("\n"),
        prompt: `Khu vực: ${where} (tọa độ ${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)})\nSố liệu: ${JSON.stringify(data)}\n\nCâu hỏi: ${input}`,
      });
      await logUsage({ kind: "weather", text: input, place: where });
      return [`${md(text)}\n_Nguồn: Open-Meteo (mô hình dự báo lưới vài km, không phải radar)_`];
    } catch (err) {
      console.error("[weather] loi:", err.message);
      return ["Chưa lấy được dữ liệu thời tiết (nguồn Open-Meteo đang lỗi), thử lại sau nhé."];
    }
  }

  async function route({ chatId, userId, userName, input, context, turn }) {
    if (/^\/(?:help|start)\b/i.test(input) || /^h[uư][oớ]ng\s*d[aẫ]n$/i.test(input)) return [HELP];
    // Lenh go ro rang (ban giao:/log:/day:/ghi nho:) -> lam luon, khong can doan.
    let forcedTeach = "";
    for (const c of COMMANDS) {
      const m = input.match(c.re);
      if (!m) continue;
      const body = input.slice(m[0].length).trim();
      if (!body) return ["Nội dung trống. Gõ /help để xem cách dùng."];
      if (c.kind !== "teach") return save(c.kind, { userId, userName, body });
      forcedTeach = body;
      break;
    }
    // Con lai: Gemini doc ngu canh quyet dinh hoi / day / thoi tiet + day cho cau nao.
    const text = forcedTeach || input;
    const cls = await classify({ chatId, input: text, context });
    const { intent, gap, situation, query, call } = cls;
    // Tu day CHI dung doan chat cua chu de nay (chu de khac dang noi xen khong lot vao cau tra
    // loi / cau day). Chu de moi -> khong co ngu canh cu.
    const topic = assignTopic(chatId, turn, cls.topic, cls.topicLabel || situation || query);
    if (topic) context = recentContext(chatId, { topic, exclude: turn });
    // Hoi so lieu he thong (Jira / call center) -> vong lap cong cu co kiem soat.
    if (intent === "tool" && call) {
      if (!runTool) return [{ jira: call }]; // khong co cong cong cu (ban cu) -> zalo-bot tu chay
      return runAgent({ chatId, userId, userName, input, context, first: call, more: cls.more, jt: true });
    }
    if (forcedTeach || intent === "teach") {
      if (gap) dropGap(chatId, gap);
      return save("teach", { userId, userName, body: text, question: gap?.question || situation, auto: !forcedTeach, gap, context });
    }
    if (intent === "weather") {
      const wx = await weather(input, context);
      if (wx) return wx; // null = LLM thoi tiet thay khong phai hoi thoi tiet -> tra loi binh thuong
    }
    return answer({ chatId, userId, userName, question: input, context, searchQuery: query });
  }

  // VONG LAP CONG CU (agentic co kiem soat): tra cong cu dau tien (bo dieu phoi chon) ->
  // neu cau hoi can them (more) thi Gemini DOC KET QUA roi chon: tra loi / tra them 1 cong cu /
  // tra them tai lieu (quy trinh). Toi da MAX_TOOL_STEPS lan tra. So lieu LUON la bang do CODE
  // dinh dang; Gemini chi viet 1-3 cau nhan xet, so nao nhac toi phai co san trong ket qua.
  async function callTool(call, { userId, userName }) {
    try {
      const text = await runTool(call, { userId, userName });
      return String(text || "").trim() || "Mình tra xong nhưng không có dữ liệu trả về.";
    } catch (err) {
      console.warn(`[tool] ${call.tool} loi:`, err.message);
      return `⚠️ Mình tra ${call.tool.startsWith("callcenter") ? "call center" : "Jira"} đang lỗi, thử lại sau ít phút nhé.`;
    }
  }
  async function decideNext({ input, context, results, stepsLeft }) {
    const r = parseJson(
      await ask({
        system: [
          "Bạn là trợ lý L1 đang trả lời 1 câu hỏi bằng các công cụ tra cứu CHỈ ĐỌC. Đã tra xong ít nhất 1 công cụ (KẾT QUẢ ở dưới). Chỉ trả về 1 object JSON:",
          '{"action":"answer"|"tool"|"kb","tool":"<khi action=tool>","params":{},"query":"<khi action=kb: câu tìm trong tài liệu quy trình>","note":"<nhận xét/trả lời thẳng, ≤ 3 câu>"}',
          "- answer: dữ liệu đã đủ. note = trả lời THẲNG câu hỏi (ai nhiều nhất, so sánh...) dựa trên KẾT QUẢ. Câu hỏi chỉ cần xem số/danh sách → note rỗng.",
          "- Câu hỏi có vế hỏi Ý KIẾN / ĐÁNH GIÁ ('có đáng lo không', 'ổn không', 'nên khen ai', 'nên làm gì') → note BẮT BUỘC trả lời vế đó bằng lý lẽ từ số liệu (vd người đó nhận rất ít cuộc nên tỉ lệ dễ lệch; so với người khác trong kết quả cao/thấp hơn nhiều), không chỉ nhắc lại số.",
          `- tool: cần tra thêm 1 công cụ KHÁC (không lặp lại công cụ + tham số đã tra). Còn tối đa ${stepsLeft} lần tra.`,
          "- kb: cần thêm QUY TRÌNH / cách xử lý trong tài liệu L1 → query = câu tìm kiếm; note như answer.",
          "- Số liệu nào nhắc trong note phải CHÉP ĐÚNG từ KẾT QUẢ, KHÔNG tự tính số mới (không tự cộng/chia/đổi %). Không bịa người/số không có trong kết quả.",
          "",
          "CÔNG CỤ:",
          TOOL_GUIDE,
        ].join("\n"),
        prompt: [
          "HỘI THOẠI GẦN ĐÂY:",
          context || "(không có)",
          "",
          `CÂU HỎI: ${input}`,
          "",
          "KẾT QUẢ ĐÃ TRA:",
          ...results.map((x, i) => `(${i + 1}) ${x.tool} ${JSON.stringify(x.params)}\n${plain(x.text).slice(0, 2500)}`),
        ].join("\n"),
      }).catch((err) => {
        console.warn("[agent] LLM loi:", err.message);
        return "";
      })
    );
    return r || { action: "answer" };
  }
  // Moi con so trong nhan xet phai xuat hien trong ket qua/cau hoi -> chan Gemini tu tinh/chep sai
  // (28/09 bot doc 413 thanh 443).
  function numbersGrounded(note, sources) {
    const src = sources.join("\n").replace(/\s+/g, " ");
    return (String(note).match(/\d+(?:[.,]\d+)?/g) || []).every((n) => src.includes(n) || src.includes(n.replace(",", ".")));
  }
  // GOI Y "L1 CAN LAM GI TIEP" cho 1 ticket: code lay ho so (mo ta + comment + lich su, chi doc),
  // model manh doc va tra loi theo khung co dinh. Chi la GOI Y - bot khong ghi gi len Jira.
  async function suggestTicket({ input, dossier }) {
    if (!/^TICKET SUP-/.test(dossier)) return [dossier]; // ma sai / khong tim thay / loi tra Jira
    const key = /^TICKET (SUP-\d+)/.exec(dossier)[1];
    const r = parseJson(
      await askStrong({
        system: [
          "Bạn là trợ lý của L1 lead team support app bán hàng. Đọc HỒ SƠ TICKET Jira và cho biết ticket đang tới đâu, ai đang phải hành động, L1 nên làm gì tiếp. Chỉ trả về 1 object JSON:",
          '{"dang_o_dau":"<1-2 câu: đã làm được gì, đã ra nguyên nhân chưa>","dang_cho":"<ai đang phải hành động tiếp + chờ bao lâu (số ngày lấy từ hồ sơ)>","l1_nen_lam":["<việc cụ thể L1 làm được>"],"luu_y":"<chỗ bất thường, vd trạng thái không khớp nội dung comment; không có thì rỗng>"}',
          "- CHỈ dựa vào hồ sơ, không bịa người/việc/số. L1 = team support L1 (thường là người raise); L2 = người đang giữ khi Level 2; người được @tag trong comment = người đang được nhờ.",
          "- l1_nen_lam: 2-4 việc, mỗi việc ≤ 25 từ, là việc L1 tự làm được (báo khách, nhắc người đang được nhờ, hỏi lại L2, xác nhận để đóng...). KHÔNG giao L1 việc của team khác (sửa SAP, sửa code...).",
          "- Tiếng Việt, ngắn gọn, giọng cộng tác.",
        ].join("\n"),
        prompt: `CÂU HỎI: ${input}\n\nHỒ SƠ TICKET:\n${dossier}`,
      }).catch((err) => {
        console.warn("[ticket-goi-y] LLM loi:", err.message);
        return "";
      })
    );
    const head = dossier.split("\n").slice(0, 4);
    if (!r?.dang_o_dau) return [`${md(head.join("\n"))}\n\n_Mình chưa tóm tắt được ticket này, bạn mở link xem giúp mình nhé._`];
    const steps = (Array.isArray(r.l1_nen_lam) ? r.l1_nen_lam : []).slice(0, 4);
    return [
      [
        `# 🧭 ${md(head[0].replace(/^TICKET /, ""))}`,
        md(head[2]),
        md(head[3]),
        "",
        `**📍 Đang ở đâu:** ${md(r.dang_o_dau)}`,
        r.dang_cho ? `**⏳ Đang chờ:** ${md(r.dang_cho)}` : "",
        steps.length ? "**✅ L1 nên làm:**" : "",
        ...steps.map((x, i) => `${i + 1}. ${md(x)}`),
        r.luu_y ? `{yellow}⚠️ ${md(r.luu_y)}{/yellow}` : "",
        "──────────",
        `_Gợi ý của bot (đọc ticket lúc này), chưa phải quyết định · ${BROWSE}${key}_`,
      ]
        .filter((x) => x !== "")
        .join("\n"),
    ];
  }
  const BROWSE = process.env.TICKET_BROWSE_URL || "https://your-team.atlassian.net/browse/";

  async function runAgent({ chatId, userId, userName, input, context, first, more }) {
    // Hoi ve 1 ticket cu the -> doc ho so roi goi y (khong lap vong cong cu).
    if (first.tool === "ticket_goi_y") {
      const dossier = await callTool(first, { userId, userName });
      const replies = await suggestTicket({ input, dossier });
      replies.toolTrace = `(đã tra: ticket_goi_y ${JSON.stringify(first.params)})`;
      await logUsage({ kind: "tool", user: userName, text: input, tools: [first] });
      return replies;
    }
    const results = [];
    let call = first;
    let note = "";
    let kbQuery = "";
    for (let step = 0; call && step < MAX_TOOL_STEPS; step++) {
      results.push({ ...call, text: await callTool(call, { userId, userName }) });
      call = null;
      if (!more) break;
      const d = await decideNext({ input, context, results, stepsLeft: MAX_TOOL_STEPS - step - 1 });
      note = String(d.note || "").trim();
      if (d.action === "tool" && step + 1 < MAX_TOOL_STEPS && Object.prototype.hasOwnProperty.call(TOOLS, d.tool)) {
        const next = { tool: d.tool, params: TOOLS[d.tool](d.params || {}) };
        if (!results.some((x) => x.tool === next.tool && JSON.stringify(x.params) === JSON.stringify(next.params))) call = next;
      } else if (d.action === "kb" && d.query) kbQuery = String(d.query).slice(0, 300);
    }
    if (note && !numbersGrounded(note, [input, ...results.map((x) => plain(x.text))])) {
      console.warn(`[agent] bo nhan xet co so khong khop ket qua: ${note.slice(0, 120)}`);
      note = "";
    }
    const replies = results.map((x) => x.text);
    if (note) replies[0] = `💬 ${md(note)}\n\n${replies[0]}`;
    if (kbQuery) replies.push(...(await answer({ chatId, userId, userName, question: input, context, searchQuery: kbQuery })));
    replies.toolTrace = `(đã tra: ${results.map((x) => `${x.tool} ${JSON.stringify(x.params)}`).join("; ")})`;
    await logUsage({ kind: "tool", user: userName, text: input, tools: results.map((x) => ({ tool: x.tool, params: x.params })), more, note: note || undefined, kb: kbQuery || undefined });
    return replies;
  }

  async function handle({ chatId, userId, userName, text }) {
    const input = String(text || "").normalize("NFC").trim();
    if (!input) return [];
    const context = recentContext(chatId);
    // Ghi tin nguoi hoi NGAY khi toi (moc "lan cuoi noi chuyen" tinh tu luc nay, khong
    // doi bot tra loi xong); context da lay o tren nen khong lap lai chinh tin nay.
    const turn = pushTurn(chatId, userName, input);
    const replies = await route({ chatId, userId, userName, input, context, turn });
    // Cau tra loi cua bot thuoc cung chu de voi cau hoi. Da tra cong cu -> ghi kem "(da tra: ...)"
    // de cau noi tiep ("con Chi thi sao") giu dung cong cu + tham so.
    if (typeof replies[0] === "string") pushTurn(chatId, "Bot", `${replies.toolTrace ? `${replies.toolTrace}\n` : ""}${replies[0]}`, turn?.topic);
    // Ban cu (khong co cong cong cu): ket qua do zalo-bot gui -> van ghi lai bot VUA TRA GI.
    else if (replies[0]?.jira) pushTurn(chatId, "Bot", `(đã tra: ${replies[0].jira.tool} ${JSON.stringify(replies[0].jira.params)})`, turn?.topic);
    return replies;
  }

  // DE XUAT GOP cho job review cuoi tuan: muc day "cach xu ly moi" (khong phai sua 1 y) ->
  // Gemini de xuat them vao WF nao, cho nao, viet san doan theo van phong WF. Ha duyet roi
  // Claude sua file. Muc da co "Sua cho: WFxx" (cu -> moi) thi khong can de xuat.
  async function draftMerge(body) {
    if (/^Sửa cho: WF\d+/m.test(body)) return null;
    try {
      const wf = await wfCandidates(String(body).replace(/^Lời dạy gốc:[\s\S]*$/m, "").slice(0, 1500));
      const r = parseJson(
        await askStrong({
          system: [
            "Bạn giúp gộp 1 mục kiến thức team L1 vừa dạy vào workflow matrix. Các WFxx cho sẵn có dạng: dòng tiêu đề 'WFxx. Hệ thống — vấn đề', 'Các bước kiểm tra/xử lý: (1)... (2)...', 'Nhánh xử lý theo tình huống: (a)... (b)...', 'Điểm handover/escalation: ...'. Chỉ trả về 1 object JSON:",
            '{"action":"add_branch"|"edit"|"new_wf"|"duplicate","target":"<WFxx, rỗng nếu new_wf>","where":"<chỗ thêm/sửa, vd \'Nhánh xử lý theo tình huống — thêm (c)\'>","old":"<chỉ khi edit: đoạn NGUYÊN VĂN cũ trong WF>","text":"<đoạn đề xuất, viết đúng văn phong WF>","note":"<điều Ha cần tự quyết, ≤ 1 câu, rỗng nếu không>"}',
            "- add_branch: mục dạy là 1 tình huống/nhánh mới của 1 WF có sẵn. edit: sửa 1 đoạn WF có sẵn. new_wf: vấn đề chưa có WF nào (text = WF hoàn chỉnh, tiêu đề 'WFxx. ...' để trống số). duplicate: WF đã có đúng nội dung này.",
            "- TUYỆT ĐỐI không thêm bước, người, link, escalate không có trong mục dạy.",
          ].join("\n"),
          prompt: `WF LIÊN QUAN:\n${wf.length ? wf.join("\n\n---\n\n") : "(không có)"}\n\nMỤC TEAM DẠY:\n${body}`,
        })
      );
      if (!r?.action || !r.text) return null;
      if (r.action === "edit") {
        const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
        if (!wf.some((t) => norm(t).includes(norm(r.old)))) r.action = "add_branch";
      }
      return { action: r.action, target: r.target || "", where: r.where || "", old: r.action === "edit" ? r.old : "", text: r.text, note: r.note || "" };
    } catch (err) {
      console.warn("[draft] khong de xuat duoc:", err.message);
      return null;
    }
  }

  // DOC ANH CHUP MAN HINH (thu nghiem 30/09, chi tin rieng cua Ha voi Bot Walrus): tai anh tu CDN
  // Zalo -> Gemini CHEP lai chu tren man hinh (khong doan) + viet 1 cau hoi day du -> di tiep nhu
  // cau hoi chu binh thuong (tra WF, nho hoi thoai). Bot LUON nhac lai nguyen van da doc duoc de
  // nguoi xem biet bot doc dung hay sai.
  async function handleImage({ chatId, userId, userName, imageUrl, caption = "" }) {
    let image;
    try {
      const u = new URL(imageUrl);
      if (u.protocol !== "https:" || !/(^|\.)zdn\.vn$/i.test(u.hostname)) throw new Error("link anh khong phai CDN Zalo");
      const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.startsWith("image/")) throw new Error(`tai anh loi (HTTP ${res.status}, ${type})`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > 8 * 1024 * 1024) throw new Error("anh qua 8MB");
      image = { data, mediaType: type.split(";")[0] };
    } catch (err) {
      console.warn("[image] khong tai duoc anh:", err.message);
      return ["Mình chưa tải được ảnh này (link ảnh Zalo có thể đã hết hạn). Bạn gửi lại ảnh giúp mình nhé."];
    }
    const r = parseJson(
      await ask({
        system: [
          "Bạn đọc ẢNH CHỤP MÀN HÌNH app nội bộ (FieldGo, DMS, Cooler Audit, E-Contract, Survey App, Workflow...) mà người dùng gửi để hỏi cách xử lý. Chỉ trả về 1 object JSON:",
          '{"read":"<CHÉP NGUYÊN VĂN các chữ quan trọng trên màn hình: tiêu đề/thông báo lỗi, mã lỗi, responseCode, tên màn hình, version nếu thấy>","app":"<tên app nếu nhận ra, không chắc thì rỗng>","question":"<1 câu hỏi ĐẦY ĐỦ để tra quy trình xử lý lỗi này, kết hợp chú thích của người gửi>","unclear":<true nếu ảnh mờ/không có chữ đọc được/không phải màn hình lỗi>}',
          "- TUYỆT ĐỐI không đoán chữ không đọc rõ; chỗ nào mờ thì bỏ qua. Không tự thêm nguyên nhân hay cách xử lý.",
          "- Bỏ qua thanh trạng thái điện thoại (giờ, pin, sóng) và chữ quảng cáo/logo.",
        ].join("\n"),
        prompt: `Chú thích người gửi: ${caption || "(không có)"}`,
        image,
      }).catch((err) => {
        console.warn("[image] LLM loi:", err.message);
        return "";
      })
    );
    const read = String(r?.read || "").trim();
    await logUsage({ kind: "image", user: userName, caption, read: read.slice(0, 300), app: r?.app || undefined, question: r?.question || undefined, unclear: r?.unclear === true || undefined });
    if (!r || r.unclear === true || !read) {
      return [`🖼 Mình không đọc rõ ảnh này${read ? ` (chỉ thấy: "${md(read.slice(0, 200))}")` : ""}. Bạn gõ giúp mình nội dung lỗi trên màn hình nhé.`];
    }
    const question = String(r.question || `${caption} ${read}`).trim();
    const replies = await handle({ chatId, userId, userName, text: question });
    const head = `🖼 **Mình đọc được trên ảnh${r.app ? ` (${md(r.app)})` : ""}:**\n${quoteRead(read)}`;
    if (typeof replies[0] === "string") replies[0] = `${head}\n\n${replies[0]}`;
    else replies.unshift(head);
    return replies;
  }
  const quoteRead = (t) =>
    String(t)
      .split(/\n+/)
      .filter((l) => l.trim())
      .slice(0, 8)
      .map((l) => `> ${md(l.trim())}`)
      .join("\n");

  return { handle, handleImage, draftMerge };
}
