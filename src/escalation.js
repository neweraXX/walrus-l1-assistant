// Hoc chuyen tuyen theo loai loi; admin chi phu quyet hoac bo sung.
import { readFile, writeFile } from "node:fs/promises";
import { stamp } from "./memory.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPLY_RE = /^#\s*(C[1-9]\d*)\s+([\s\S]+)$/i;
const COMMAND_RE = /^#\s*(sai|mo)\s+(C[1-9]\d*)(?:\s+([\s\S]+))?$/i;
const MILESTONES = [3, 10, 30, 100];

// Khong de lot SDT, email, ma user/outlet vao tin nhan / bo nho.
export function scrub(text) {
  return String(text || "")
    .replace(/(?:\+?84|0)\d{9,10}\b/g, "[SĐT]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b(?:VN|OUT-?|SR-?)\d{4,8}\b/gi, "[mã]");
}
const brief = (text) => scrub(text).replace(/\s+/g, " ").trim();
const routeLabel = (route) => route.replace(":", " ");

function parseJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

function dominant(rule) {
  const entries = Object.entries(rule.counts).sort((a, b) => b[1] - a[1]);
  const count = entries[0]?.[1] || 0;
  // Hoa thi giu route da nho, tranh doi luat khi chua co route vuot len.
  const route = rule.rememberedRoute && rule.counts[rule.rememberedRoute] === count ? rule.rememberedRoute : entries[0]?.[0];
  return { route, count, confidence: rule.total ? count / rule.total : 0 };
}

function rememberReason(rule) {
  if (rule.status === "blocked") return null;
  const top = dominant(rule);
  if (rule.total < 2 || top.confidence < 0.6) return null;
  if (!rule.rememberedAt && rule.total >= 2 && top.confidence >= 0.6) return "MỚI";
  if (rule.rememberedRoute && top.route !== rule.rememberedRoute) return "ĐỔI";
  // Giu moc chua ghi duoc neu relayer loi o lan truoc.
  return MILESTONES.some((n) => rule.rememberedTotal < n && rule.total >= n) ? "CHẠM MỐC" : null;
}

// Chi doc noi dung ruleText da luu; khong doc state hay thay doi luat cua learner.
export function parseRouteHint(text) {
  if (typeof text !== "string" || /đã bị Admin huỷ|blocked by Admin/iu.test(text)) return null;
  const head = /(?:Luật chuyển tuyến|Routing rule)\s+\[(C[1-9]\d*)\][ \t]+([^\r\n]+?)[ \t]+\(([^()\r\n]*)\)[ \t]*(?:\r?\n|$)/iu.exec(text);
  const top = /^(?:Thường xử lý bởi|Usually handled by):[ \t]*(L1|L2|VENDOR)\b[ \t]*([^\r\n]*?)[ \t]*\((\d+)\/(\d+) tickets?,[ \t]*(\d+)%\)(?:,[ \t]*(?:gần nhất|latest)[ \t]+(\d{4}-\d{2}-\d{2}))?/imu.exec(text);
  if (!head || !top) return null;
  const count = Number(top[3]), total = Number(top[4]), confidence = Number(top[5]) / 100;
  // Kiem tra ca ti le that: lam tron 59.6% thanh 60% khong du de ap dung.
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(total) || total < 2 || count > total
    || count / total < 0.6 || confidence < 0.6 || confidence > 1) return null;
  const route = top[1].toUpperCase(), target = brief(top[2]);
  if (route !== "L1" && !target) return null;
  return {
    id: head[1].toUpperCase(), category: brief(head[2]), system: brief(head[3]),
    route, target: route === "L1" ? "" : target, count, total, confidence, lastDate: top[6] || "",
    l1Action: brief(/^(?:L1 nên|L1 should):[ \t]*([^\r\n]*)/imu.exec(text)?.[1] || ""),
  };
}

export function readRouteHint(recalled, filteredRules) {
  // Ban Tester la memory rieng, co the xa hoac khong co he thong: chan ca ban luat cu
  // truoc khi doc ket qua loc v2, khong de ban cu tiep tuc hien cho L1.
  const revoked = new Set(recalled.flatMap((r) => typeof r?.text === "string"
    ? [...r.text.matchAll(/Luật\s+\[(C[1-9]\d*)\]\s+đã bị Admin huỷ/giu)].map((m) => m[1].toUpperCase()) : []));
  for (const { text } of filteredRules) {
    const hint = parseRouteHint(text);
    if (hint && !revoked.has(hint.id)) return hint;
  }
  return null;
}

// runTool ticket_da_dong / ticket_goi_y: private gateway, not included.
export function createEscalationLearner({ runTool, ask, memory, proof = null, namespace, statePath, author = "ticket gateway", llmGapMs = 13_000, excludeKeys = new Set(), language = "vi" }) {
  let state = { seen: {}, routes: Object.create(null), nextId: 1, learned: 0, runs: [] };
  const loaded = readFile(statePath, "utf8")
    .then((t) => {
      const old = JSON.parse(t);
      // Bo pending/proposals/patterns cu, giu seen de khong doc lai ticket.
      state.seen = old.seen || {};
      state.routes = Object.assign(Object.create(null), old.routes || {});
      state.learned = old.learned || 0;
      state.runs = old.runs || [];
      state.nextId = Math.max(old.nextId || 1, ...Object.values(state.routes).map((r) => Number(r.id?.slice(1)) + 1 || 1));
    })
    .catch(() => {})
    .then(() => {
      // Holdout khong duoc doc ho so hay hoc, ke ca da co seen cu.
      for (const key of excludeKeys) state.seen[key] = "holdout";
    });
  let saving = Promise.resolve();
  const save = () => {
    const text = JSON.stringify(state, null, 1);
    saving = saving.catch(() => {}).then(() => writeFile(statePath, text));
    return saving;
  };

  // Chi xep hang buoc cap nhat; admin khong phai cho ca luot doc ticket gateway/LLM.
  let updates = Promise.resolve();
  const enqueue = (fn) => {
    const task = updates.then(fn);
    updates = task.catch(() => {});
    return task;
  };

  const SYSTEM = [
    "Bạn đọc hồ sơ ticket support ĐÃ ĐÓNG và rút ra loại lỗi cùng đường chuyển tuyến cho L1.",
    "Chỉ dùng thông tin CÓ trong hồ sơ, không đoán. Trả về DUY NHẤT 1 object JSON:",
    '{"system":"<app/hệ thống>","category":"<loại lỗi chung, ≤ 6 từ>","symptom":"<triệu chứng>","route":"L1|L2|VENDOR","target":"<người/team/vendor THỰC SỰ xử lý, rỗng nếu L1>","l1Action":"<L1 nên làm gì hoặc chuyển ai kèm thông tin gì>","fix":"<cách sửa thực tế, rỗng nếu chưa ghi rõ>"}',
    '- Cột Level là gợi ý cứng: "Level 2" ⇒ KHÔNG phải L1, kể cả người đóng ticket là L1.',
    "- Đọc người giữ cuối và lịch sử để xác định người/team thực sự xử lý; không coi người đóng hộ là người sửa.",
    "- route=VENDOR khi hồ sơ cho thấy chuyển cho vendor/đối tác bên ngoài; target là tên vendor/đối tác đó.",
    "- Dùng lại ĐÚNG tên category đã có nếu cùng loại; chỉ đặt tên mới khi khác loại.",
    "- Không ghi số điện thoại, email, mã nhân viên/outlet/thiết bị cụ thể vào bất kỳ ô nào.",
  ].join("\n");

  async function extract(dossier, { key, group, level, assignee }) {
    const known = Object.entries(state.routes).sort((a, b) => b[1].total - a[1].total).map(([c]) => c);
    const hint = known.length ? `LOẠI LỖI ĐÃ CÓ (cùng loại PHẢI dùng NGUYÊN VĂN):\n${known.map((c) => `- ${c}`).join("\n")}\n\n` : "";
    const prompt = `${hint}TICKET: ${key}\nHệ thống/nhóm: ${group}\nLevel: ${level}\nNgười giữ cuối: ${assignee}\nHỒ SƠ TICKET:\n${dossier}`;
    const raw = parseJson(await ask({ system: SYSTEM, prompt: scrub(prompt) }));
    if (!raw) return null;
    const r = Object.fromEntries(["system", "category", "symptom", "route", "target", "l1Action", "fix"].map((k) => [k, typeof raw[k] === "string" ? brief(raw[k]) : ""]));
    r.category = r.category.split(/\s+/).slice(0, 6).join(" ");
    if (!r.category || !r.symptom || !["L1", "L2", "VENDOR"].includes(r.route)) return null;
    if (r.route === "L1" && /level\s*2/i.test(level)) r.route = "L2";
    if (r.route === "L1") r.target = "";
    else if (!r.target && r.route === "L2") r.target = brief(assignee === "-" ? "" : assignee);
    if (r.route !== "L1" && !r.target) return null;
    r.system ||= brief(group === "-" ? "" : group);
    return r;
  }

  function ruleText(category, rule) {
    const top = dominant(rule);
    if (language === "en") return [
      `Routing rule [${rule.id}] ${category} (${rule.system || "-"})`,
      `Usually handled by: ${routeLabel(top.route)} (${top.count}/${rule.total} tickets, ${Math.floor(top.confidence * 100)}%), latest ${rule.lastDate}`,
      `L1 should: ${rule.l1Action}`,
      `Examples: ${rule.examples.join(", ")}`,
      "Source: automatically learned from closed tickets; at least 2 tickets and 60% agreement.",
    ].join("\n");
    return [
      `Luật chuyển tuyến [${rule.id}] ${category} (${rule.system || "-"})`,
      `Thường xử lý bởi: ${routeLabel(top.route)} (${top.count}/${rule.total} ticket, ${Math.round(top.confidence * 100)}%), gần nhất ${rule.lastDate}`,
      rule.l1Action ? `L1 nên: ${rule.l1Action}${rule.l1ActionByAdmin ? " (Admin bổ sung, ưu tiên)" : ""}` : "",
      rule.fixes.length ? `Cách sửa đã ghi: ${rule.fixes.join(" / ")}` : "",
      `Ví dụ ticket: ${rule.examples.join(", ")}`,
      "Nguồn: tự học từ ticket gateway",
    ].filter(Boolean).join("\n");
  }

  async function writeMemory(text, source, { onProof } = {}) {
    const w = await memory.remember(namespace, stamp(scrub(source), scrub(text)));
    if (proof) Promise.resolve().then(() => proof.confirm(w, { namespace, author: scrub(source) }))
      .then((record) => onProof?.(record)).catch((err) => console.error("[escalation] proof loi:", err.message));
    return w;
  }

  async function rememberRule(category, rule, options) {
    if (rule.status === "blocked") return;
    await writeMemory(ruleText(category, rule), author, options);
    Object.assign(rule, { rememberedAt: new Date().toISOString(), rememberedRoute: dominant(rule).route, rememberedTotal: rule.total });
    state.learned++;
    await save();
  }

  function addFix(rule, fix) {
    if (fix) rule.fixes = [...rule.fixes.filter((f) => f !== fix), fix].slice(-3);
  }

  async function runDaily({ days = 2, max = 30 } = {}) { // 30 x 13s ~ 7 phut, LLM free dung chung bot L1
    if (!Number.isSafeInteger(days) || days < 1) throw new Error("days phai la so nguyen duong");
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("max phai la so nguyen duong");
    // Backfill toi 14 ngay bang nhieu luot ngan; gioi han ap dung sau khi bo
    // seen/holdout/trung key de luot sau tien den ticket chua hoc, toi da 30/luot.
    days = Math.min(days, 14);
    max = Math.min(max, 30);
    await loaded;
    const list = String((await runTool({ tool: "ticket_da_dong", params: { days } }, { userId: "escalation-job", userName: "escalation-job" })) || "");
    const rows = list.split("\n").map((l) => l.split(" | "))
      .filter((c) => c.length >= 6 && /^[A-Z][A-Z0-9]*-\d+$/.test(c[0]));
    const unique = new Set();
    const fresh = rows.filter(([key]) => !excludeKeys.has(key) && !state.seen[key] && !unique.has(key) && unique.add(key)).slice(0, max);
    const out = { at: new Date().toISOString(), checked: fresh.length, categories: 0, total: 0, changes: [], failed: 0 };
    const touched = new Set(), changes = new Map();
    const noteChange = (category, rule, reason) => {
      // Loai moi trong luot nay luon hien "MOI" (khong bi de boi CHAM MOC luc ghi cuoi luot).
      const prev = changes.get(category)?.reason;
      if (reason || prev) changes.set(category, { category, id: rule.id, system: rule.system, ...dominant(rule), total: rule.total, reason: prev === "MỚI" ? prev : reason || prev });
    };
    const maybeRemember = async (category, rule) => {
      const reason = rememberReason(rule);
      if (!reason) return;
      try {
        await rememberRule(category, rule);
        noteChange(category, rule, reason);
      } catch (err) {
        console.error(`[escalation] ${rule.id} khong ghi duoc:`, err.message);
      }
    };
    // Thu lai luat chua ghi duoc, khong doc va dem lai ticket cu.
    await enqueue(async () => {
      for (const [category, rule] of Object.entries(state.routes)) await maybeRemember(category, rule);
    });
    for (const [key, group, level, assignee, resolved] of fresh) {
      try {
        const dossier = String((await runTool({ tool: "ticket_goi_y", params: { key } }, { userId: "escalation-job", userName: "escalation-job" })) || "");
        const extracted = await extract(dossier, { key, group, level, assignee });
        if (!extracted) throw new Error("JSON chuyen tuyen khong hop le");
        await enqueue(async () => {
          if (excludeKeys.has(key) || state.seen[key]) return;
          const { category } = extracted;
          const isNew = !state.routes[category];
          const r = state.routes[category] ||= {
            id: `C${state.nextId++}`, system: extracted.system, counts: {}, total: 0, lastDate: "", examples: [],
            l1Action: "", fixes: [], status: "active", rememberedAt: null, rememberedRoute: null, rememberedTotal: 0,
          };
          const previous = dominant(r).route;
          const route = extracted.route === "L1" ? "L1" : `${extracted.route}:${extracted.target}`;
          r.counts[route] = (r.counts[route] || 0) + 1;
          r.total++;
          r.system = extracted.system || r.system;
          const date = brief(resolved).match(/\d{4}-\d{2}-\d{2}/)?.[0] || brief(resolved);
          if (date > r.lastDate) r.lastDate = date;
          r.examples = [...r.examples.filter((x) => x !== key), key].slice(-5);
          if (extracted.l1Action && !r.l1ActionByAdmin) r.l1Action = extracted.l1Action;
          addFix(r, extracted.fix);
          state.seen[key] = "counted";
          touched.add(category);
          noteChange(category, r, isNew ? "MỚI" : previous !== dominant(r).route ? "ĐỔI" : null);
          await save();
        });
      } catch (err) {
        out.failed++;
        console.error(`[escalation] ${key} loi:`, err.message);
      }
      await sleep(llmGapMs); // LLM free: 5 req/phut/model
    }
    // Ghi Walrus 1 lan/loai/luot, theo trang thai CUOI (khong ghi 2 lan khi vua MOI vua CHAM MOC).
    await enqueue(async () => {
      for (const category of touched) await maybeRemember(category, state.routes[category]);
    });
    await enqueue(async () => {
      out.categories = touched.size;
      out.total = Object.keys(state.routes).length;
      out.changes = [...changes.values()];
      state.runs = [...state.runs.slice(-29), { at: out.at, checked: out.checked, categories: out.categories, failed: out.failed }];
      await save();
    });
    return out;
  }

  function formatRun(out) {
    const lines = [`📚 Học chuyển tuyến: đọc ${out.checked} ticket mới → ${out.categories} loại lỗi (tổng ${out.total}).`];
    for (const r of out.changes.slice(0, 6)) lines.push(`[${r.id}] ${brief(r.category)} (${brief(r.system) || "-"}) → ${brief(routeLabel(r.route))} ${r.count}/${r.total} · ${r.reason}`);
    if (out.failed) lines.push(`Ticket đọc lỗi: ${out.failed}.`);
    lines.push(`Sai thì nhắn: #sai ${out.changes[0]?.id || "C7"} · Bổ sung: #${out.changes[0]?.id || "C7"} <ghi chú>`);
    return lines.join("\n");
  }

  // index.js chi goi tu DM admin; chung hang voi buoc cong don de tranh ghi sau #sai.
  function handleReply(text, userName, options = {}) {
    return enqueue(() => handleCommand(text, userName, options));
  }

  async function handleCommand(text, userName, options) {
    const input = String(text || "").trim();
    const command = COMMAND_RE.exec(input), reply = REPLY_RE.exec(input);
    if (!command && !reply) return /^#\s*(?:sai\b|mo\b|C\d)/i.test(input) ? "Cú pháp: #sai C7 [lý do] · #mo C7 · #C7 <ghi chú>." : null;
    await loaded;
    const action = command ? command[1].toLowerCase() : "reply";
    const id = (command ? command[2] : reply[1]).toUpperCase();
    const body = brief(command ? command[3] || "" : reply[2]);
    const entry = Object.entries(state.routes).find(([, r]) => r.id === id);
    if (!entry) return `Không tìm thấy luật [${id}].`;
    const [category, r] = entry;
    if (action === "mo") {
      if (body) return "Cú pháp: #mo C7.";
      r.status = "active";
      delete r.revokedAt;
      await save();
      return `Đã mở luật [${id}].`;
    }
    if (action === "sai") {
      r.status = "blocked";
      r.reason = body || r.reason || "Sai đường chuyển tuyến";
      await save();
      if (r.rememberedAt && !r.revokedAt) {
        await writeMemory(`Luật [${id}] đã bị Admin huỷ: ${r.reason}`, userName || "Admin", options);
        r.revokedAt = new Date().toISOString();
        await save();
      }
      return `Đã chặn luật [${id}].`;
    }
    addFix(r, body);
    r.l1Action = body;
    r.l1ActionByAdmin = true;
    await save();
    if (r.status === "blocked") return `Đã bổ sung [${id}]; luật đang bị chặn, dùng #mo ${id} để mở.`;
    await rememberRule(category, r, options);
    return `✅ Đã bổ sung luật [${id}]: ${body}`;
  }

  async function listRules() {
    await loaded;
    return Object.entries(state.routes).filter(([, r]) => r.status === "active" && r.total >= 2 && dominant(r).confidence >= 0.6)
      .map(([category, r]) => structuredClone({ category, route: dominant(r).route, confidence: dominant(r).confidence, total: r.total, l1Action: r.l1Action, examples: r.examples }));
  }

  async function stats() {
    await loaded;
    return structuredClone({ learned: state.learned, routes: Object.keys(state.routes).length, blocked: Object.values(state.routes).filter((r) => r.status === "blocked").length, runs: state.runs });
  }

  return { runDaily, formatRun, handleReply, listRules, stats };
}
