// Dinh dang tin nhan Zalo (parse_mode=markdown). LLM CHI tra noi dung (JSON),
// code tu ghep tieu de/mau/nguon - tranh LLM viet markup loi (vd ma co dau "_"
// bi bien thanh chu nghieng). Quy uoc mau: do = qua han/loi, cam = escalate,
// vang = chua verify/can luu y, xanh = xong/da hoc.
const SEP = "──────────";

// Escape ky tu markup trong noi dung tu do (LLM / nguoi dung go).
export function md(s) {
  return String(s ?? "")
    .replace(/([\\*_`])/g, "\\$1")
    .replace(/~~/g, "\\~\\~") // chi "~~" moi thanh gach ngang; "~05:56" giu nguyen
    .replace(/^(\s*)([#>])/gm, "$1\\$2");
}

function quote(s) {
  return String(s)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => `> ${md(l.trim())}`)
    .join("\n");
}

// "2026-09-25 10:23" -> "25/09 10:23"
export function shortStamp(stamp) {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(stamp || "");
  return m ? `${m[2]}/${m[1]} ${m[3]}` : stamp || "";
}

export function shortDate(date) {
  if (!(date instanceof Date) || isNaN(date)) return "";
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" });
  return p.format(date);
}

export function fmtWorkflow({ title, intro, steps = [], escalate, unverified, source, changeNote, pendingNote }) {
  const lines = [`# 🛠 ${md(title || "Cách xử lý")}`];
  if (intro) lines.push(md(intro));
  // LLM doi khi tu danh so san ("1. ...") -> bo so cu de khong thanh "1. 1."
  steps.forEach((s, i) => lines.push(`${i + 1}. ${md(String(s).replace(/^\s*(?:(?:b[uư][oớ]c\s*)?\d+\s*[.):-]|[-•*])\s*/i, ""))}`));
  if (escalate) lines.push(`{orange}⬆️ Escalate:{/orange} ${md(escalate)}`);
  if (unverified) lines.push("{yellow}⚠️ Chưa verify — xác nhận lại trước khi báo KH{/yellow}");
  if (changeNote) lines.push(`{yellow}🔄 ${md(changeNote)}{/yellow}`);
  // Cau day chua duyet bi gac lai vi mau thuan WF (phuong an B) -> van cho team thay de biet.
  if (pendingNote) lines.push(`{yellow}⚠️ Chưa duyệt: ${md(pendingNote.replace(/\s*\(chưa duyệt\)/i, ""))}{/yellow}`);
  lines.push(SEP);
  lines.push(`_${source ? `Nguồn: ${md(source)} · ` : ""}Sai bước nào → gõ dạy: <bước đúng>_`);
  return lines.join("\n");
}

// Hoi lai 1 cau de chon dung nhanh xu ly (thay vi do het cac nhanh).
export function fmtClarify({ title, check, question, options = [], source }) {
  const lines = [`# 🔎 ${md(title || "Cần thêm 1 thông tin")}`];
  if (check) lines.push(`Trước tiên: ${md(check)}`);
  lines.push(`**❓ ${md(question)}**`);
  for (const o of options) lines.push(`• ${md(o.answer)} → ${md(o.next)}`);
  lines.push(SEP);
  lines.push(`_${source ? `Nguồn: ${md(source)} · ` : ""}Trả lời để mình chỉ đúng các bước, hoặc nhắn "xem hết"_`);
  return lines.join("\n");
}

export function fmtMissing(question) {
  return [
    "# 🤷 Chưa có trong tài liệu",
    quote(question),
    "💡 Ai biết cách xử lý thì nhắn cách làm (gõ \"dạy:\" hay không đều được)",
    "_Không cần ghi lại câu hỏi, mình tự ghép với câu trên._",
  ].join("\n");
}

// t = ban Gemini chuan hoa (tinh huong, buoc, escalate, ghi chu, patch WF) -> hien lai de
// nguoi day thay bot HIEU the nao; khong co t (LLM loi) thi hien nguyen van loi day.
export function fmtTaught({ question, body, t, unverified, userName, when, auto }) {
  const lines = ["{green}✅ Đã học{/green}"];
  if (question) lines.push(quote(`❓ ${question}`));
  if (t?.patch) {
    lines.push(`✏️ Mình hiểu đây là cập nhật **${md(t.patch.ref)}**, các bước khác giữ nguyên:`);
    for (const e of t.patch.edits) lines.push(`• Cũ: ${md(e.old)}`, `  Mới: ${md(e.new)}`);
  } else if (t?.steps?.length) {
    lines.push("🛠 Mình ghi lại thành:");
    t.steps.forEach((x, i) => lines.push(`${i + 1}. ${md(x)}`));
    if (t.escalate) lines.push(`{orange}⬆️ Escalate:{/orange} ${md(t.escalate)}`);
    if (t.note) lines.push(`_📝 ${md(t.note)}_`);
  } else {
    lines.push(quote(`🛠 ${body}`));
  }
  if (unverified) lines.push("{yellow}⚠️ Đánh dấu: chưa verify{/yellow}");
  if (!question) lines.push("_Không rõ câu hỏi gốc — lần sau ghi kèm tình huống để mình tra trúng hơn._");
  lines.push(`_✍️ ${md(userName)} · ${shortStamp(when)}${t ? " · hiểu sai thì nhắn lại cho đúng nhé" : ""}_`);
  if (auto) lines.push("_Mình hiểu đây là chỉ dẫn nên đã tự ghi nhớ. Nếu không phải, báo mình nhé._");
  return lines.join("\n");
}

function routeHintConflicts(hint, escalate) {
  const normalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wf = normalize(escalate).split(/\b(?:khi|neu|kem)\b/)[0].trim();
  if (!wf) return false;
  if (/\b(?:khong|ko)\b|\bl1 tu xu ly\b/.test(wf)) return hint.route !== "L1";
  if (hint.route === "L1") return true;
  const route = /\b(l1|l2|vendor)\b/.exec(wf)?.[1]?.toUpperCase();
  if (route && route !== hint.route) return true;
  const words = (text) => normalize(text).replace(/\b(?:chuyen|cho|lien he|bao|escalate|l1|l2|vendor|noi bo|phu trach|xu ly|team|nhom|anh|chi)\b/g, " ")
    .trim().split(/\s+/).filter(Boolean);
  const a = words(wf), b = words(hint.target);
  return !!(a.length && b.length && !a.every((x) => b.includes(x)) && !b.every((x) => a.includes(x)));
}

export function fmtRouteHint(hint, { escalate, sourceRef, language = "vi", plain = false } = {}) {
  if (!hint) return "";
  const clean = (text, max) => String(text || "").replace(/\b(?:blockchain|chain|walrus)\b/gi, "")
    .replace(/\s+/g, " ").trim().slice(0, max);
  const target = clean(hint.target, 80);
  if (language === "en") {
    const destination = hint.route === "L1" ? "L1 handled it" : `usually routed to ${hint.route}${target ? ` ${target}` : ""}`;
    const action = clean(hint.l1Action, 140);
    const text = `↪ Similar past issues: ${destination} (${hint.count}/${hint.total} tickets).${action ? `\nL1 should: ${action}` : ""}`;
    return plain ? text : md(text);
  }
  const last = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hint.lastDate || "");
  const stats = `${hint.count}/${hint.total} lần${hint.route !== "L1" && last ? `, gần nhất ${last[3]}/${last[2]}` : ""}`;
  let text = hint.route === "L1"
    ? `↪️ Lỗi tương tự trước đây: L1 tự xử lý được (${stats}).`
    : `↪️ Lỗi tương tự trước đây: thường chuyển **${md(`${hint.route}${target ? ` ${target}` : ""}`)}** (${stats}).`;
  if (/\bWF\d+\b/i.test(sourceRef || "") && routeHintConflicts(hint, escalate)) text += " (khác hướng dẫn WF — báo Admin kiểm)";
  const action = clean(hint.l1Action, 140);
  if (action) text += `\nL1 nên: ${md(action)}`;
  return text;
}


export function fmtProof(r) {
  if (r?.status === "pending") return "⏳ Đang xác nhận lưu trữ, mình sẽ báo lại.";
  if (r?.ok) return `{green}🔒 Đã lưu chắc chắn{/green} — kiến thức ${md(r.author || "")} vừa dạy đã vào bộ nhớ chung, cả team hỏi là thấy.`;
  return "{orange}⚠️ Kiến thức vừa dạy chưa lưu được vào bộ nhớ chung.{/orange} Nhờ dạy lại giúp mình (hoặc báo Admin).";
}
