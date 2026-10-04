// BO TEST BOT (eval/cases.json, ban may chay cua eval/bo-de-test.md team duyet 27/09).
// Chay moi sang + sau moi lan deploy. CHI DOC: ban sao bot khong ghi kho day / ky uc /
// addendum, khong gui Zalo. Moi case 1 doan chat rieng; "__RESTART__" = tao bot moi doc lai
// file phien (kiem tra nho doan chat qua restart). Gemini cham theo NGHIA cot must/mustNot,
// loai tin (expect) cham bang dau hieu trong cau tra loi.
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistant } from "./assistant.js";

function parseJson(s) {
  const a = String(s).indexOf("{");
  const b = String(s).lastIndexOf("}");
  try {
    return a >= 0 && b > a ? JSON.parse(String(s).slice(a, b + 1)) : null;
  } catch {
    return null;
  }
}

// Loai tin bot da hieu, suy tu cau tra loi (khong can mo ben trong bot).
function kindOf(reply) {
  if (/^\{"jira":/.test(reply) || /🔧 TOOL /.test(reply)) return "jira";
  if (/✅ Đã học/.test(reply)) return "teach";
  if (/Open-Meteo/.test(reply)) return "weather";
  if (/^# (?:🛠|🔎|🤷)/m.test(reply)) return "ask";
  return "chat";
}

// So lieu GIA cho cong cu khi chay bo test (khong goi Jira/tổng đài that).
const FAKE_CC = [
  ["binh@example.com", 413, 40, "8.8%"],
  ["dung@example.com", 289, 66, "18.6%"],
  ["an@example.com", 13, 7, "35%"],
  ["chi@example.com", 266, 24, "8.3%"],
  ["em@example.com", 177, 5, "2.7%"],
];
const FAKE_TOOL_DATA = {
  callcenter_tong_quan: FAKE_CC.map(([e, n, m, r]) => `👤 ${e}: nhận ${n} | miss ${m} | tỉ lệ miss ${r}`).join("\n"),
  callcenter_top: FAKE_CC.map(([e, n, m, r]) => `${e}: nhận ${n} | miss ${m} | tỉ lệ miss ${r}`).join("\n"),
};
// Cong cu 1 nguoi: tra dung dong cua nguoi duoc hoi (khop ten khong dau voi email).
function fakeToolData(tool, params = {}) {
  if (tool !== "callcenter_agent") return FAKE_TOOL_DATA[tool] || "(dữ liệu giả: không có)";
  const want = String(params.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
  const row = FAKE_CC.find(([e]) => want && e.split("@")[0].split(".").includes(want));
  return row ? `👤 ${row[0]}: nhận ${row[1]} | miss ${row[2]} | tỉ lệ miss ${row[3]}` : `Không thấy cuộc gọi nào của "${params.name}".`;
}

// Chay luc 02:00, khong ai dung -> di cham: nghi 45s giua cac case (~30 phut ca bo).
const PAUSE_MS = 45 * 1000;
const RETRY_WAIT_MS = 2 * 60 * 1000;

export function createEvalRunner({ memory, ask, askStrong, directory, kbPointerPath, kbCacheDir, casesPath, lastPath }) {
  // Ban sao memory: doc that, ghi thi bo qua.
  const readOnlyMemory = { ...memory, remember: async () => ({}), analyze: async () => {} };
  const make = (group, statePath) =>
    createAssistant({
      memory: readOnlyMemory,
      ask,
      askStrong,
      directory,
      incident: { check: async () => null },
      includePrivateKb: group === "rieng",
      jiraTools: group !== "rieng",
      // KHONG goi he thong that khi test: tra ve dau vet cong cu + so lieu GIA (lay tu report 28/09).
      runTool: async ({ tool, params }) => `🔧 TOOL ${tool} ${JSON.stringify(params)}\n${fakeToolData(tool, params)}`,
      kbPointerPath,
      kbCacheDir,
      addendumPath: "",
      statePath,
    });

  // Cham 2 buoc: model lite cham truoc (nhanh, it bi gioi han); CHI khi lite bao truot moi
  // nho model manh cham lai de xac nhan (lite hay bat loi chu - 28/09 "L1 khong ho tro" bi
  // cham thieu). Dem 28/09 cham het bang model manh -> 429 lien tuc, ca bo chay 109 phut.
  async function judgeWith(llm, { question, reply, must, mustNot }) {
    const r = parseJson(
      await llm({
        system: [
          "Bạn chấm câu trả lời của 1 bot support. Chỉ trả về 1 object JSON:",
          '{"missing":["<ý PHẢI CÓ mà câu trả lời thiếu>"],"forbidden":["<ý KHÔNG ĐƯỢC CÓ mà câu trả lời lại có>"]}',
          "- Chấm theo NGHĨA, không cần đúng nguyên văn: diễn đạt khác nhưng cùng ý vẫn tính là có.",
          "- Bot chỉ nhắc lại câu hỏi, hoặc nói không biết/không rõ → KHÔNG tính là có ý cấm.",
          "- Chỉ liệt kê đúng các ý trong 2 danh sách cho sẵn, chép lại nguyên văn ý đó.",
        ].join("\n"),
        prompt: [
          `CÂU HỎI CUỐI: ${question}`,
          "",
          "CÂU TRẢ LỜI CỦA BOT:",
          reply,
          "",
          "PHẢI CÓ:",
          ...(must.length ? must.map((x) => `- ${x}`) : ["(không có)"]),
          "KHÔNG ĐƯỢC CÓ:",
          ...(mustNot.length ? mustNot.map((x) => `- ${x}`) : ["(không có)"]),
        ].join("\n"),
      })
    );
    return { missing: r?.missing || [], forbidden: r?.forbidden || [] };
  }
  async function judge({ question, reply, must = [], mustNot = [] }) {
    if (!must.length && !mustNot.length) return { missing: [], forbidden: [] };
    const first = await judgeWith(ask, { question, reply, must, mustNot });
    if (!first.missing.length && !first.forbidden.length) return first;
    return judgeWith(askStrong, { question, reply, must, mustNot }).catch(() => first);
  }

  let running = false;
  async function runOnce(c, t0, attempt = 1) {
    const started = Date.now();
    const chatId = `eval-${c.id}-${t0}-${attempt}`;
    const statePath = path.join(os.tmpdir(), `${chatId}.json`);
    let bot = make(c.group, statePath);
    const say = async (text) => (await bot.handle({ chatId, userId: "eval", userName: "Test", text }))[0] || "";
    let reply = "";
    let question = "";
    try {
      for (const turn of c.turns) {
        if (turn === "__RESTART__") {
          bot = make(c.group, statePath);
          continue;
        }
        question = turn;
        reply = await say(turn);
        if (typeof reply !== "string") reply = JSON.stringify(reply);
      }
      // Bot hoi lai (🔎) ma case khong nham test hoi lai -> xin xem het roi moi cham.
      if (/^# 🔎/m.test(reply) && !c.expect && c.id !== "C4") {
        question = "xem hết";
        reply = await say("xem hết");
      }
      const problems = [];
      if (c.expect && kindOf(reply) !== c.expect) problems.push(`hiểu nhầm loại tin: ra "${kindOf(reply)}", đúng là "${c.expect}"`);
      const j = await judge({ question, reply, must: c.must, mustNot: c.mustNot });
      for (const m of j.missing) problems.push(`thiếu: ${m}`);
      for (const f of j.forbidden) problems.push(`có ý cấm: ${f}`);
      return { id: c.id, pass: !problems.length, problems, question, reply: reply.slice(0, 600), ms: Date.now() - started };
    } catch (err) {
      return { id: c.id, pass: false, problems: [`lỗi khi chạy: ${err.message}`], question, reply: "", ms: Date.now() - started };
    }
  }

  // Chay 1 case; loi ha tang (vd Gemini 429 ca 3 model) -> doi 2 phut thu lai 1 lan.
  async function runCase(c, t0) {
    const first = await runOnce(c, t0);
    if (first.pass || !first.problems.some((p) => p.startsWith("lỗi khi chạy"))) return first;
    await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    return runOnce(c, t0, 2);
  }

  // only = ["T1","T2"]: chay rieng vai cau (thu nhanh sau khi sua) -> KHONG ghi de ket qua dem.
  async function run({ only } = {}) {
    if (running) throw new Error("dang chay roi");
    running = true;
    const t0 = Date.now();
    try {
      let { cases } = JSON.parse(await readFile(casesPath, "utf8"));
      if (only?.length) cases = cases.filter((c) => only.includes(c.id));
      const results = [];
      for (const [i, c] of cases.entries()) {
        // Nghi giua cac case: Gemini gioi han so lan goi/phut; chay don dap (lan dau 27/09) lam
        // ca 3 model bi 429 -> bot that cung khong tra loi duoc. ~10-12 phut cho ca bo.
        if (i) await new Promise((r) => setTimeout(r, PAUSE_MS));
        results.push(await runCase(c, t0));
      }

      // So voi lan chay truoc: cau nao vua hong / vua het loi.
      const last = JSON.parse(await readFile(lastPath, "utf8").catch(() => "null"));
      const before = new Map((last?.results || []).map((r) => [r.id, r.pass]));
      const newlyFailed = results.filter((r) => !r.pass && before.get(r.id) === true).map((r) => r.id);
      const newlyFixed = results.filter((r) => r.pass && before.get(r.id) === false).map((r) => r.id);
      const out = {
        at: new Date().toISOString(),
        total: results.length,
        passed: results.filter((r) => r.pass).length,
        seconds: Math.round((Date.now() - t0) / 1000),
        newlyFailed,
        newlyFixed,
        results,
      };
      if (!only?.length) await writeFile(lastPath, JSON.stringify(out, null, 2)).catch((err) => console.error("[eval] khong ghi duoc ket qua:", err.message));
      console.log(`[eval] ${out.passed}/${out.total} dat (${out.seconds}s)`);
      return out;
    } finally {
      running = false;
    }
  }

  return { run };
}
