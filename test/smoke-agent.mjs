// BAI CHAY THU TRUOC MOI LAN DEPLOY bo nao (khong goi mang, Gemini/cong cu deu gia):
//   docker run --rm --network none -v "$PWD/src:/app/src:ro" -v "$PWD/test:/t:ro" -w /app \
//     --entrypoint node walrus-l1-assistant-l1-assistant:latest /t/smoke-agent.mjs
// In "SMOKE OK" va thoat 0 neu dung; sai thi in chi tiet + thoat 1 (KHONG deploy).
// Kiem: dieu phoi -> cong cu -> nhan xet; cau noi tiep giu cong cu; loi day da gop bi bo qua.
import { createAssistant } from "/app/src/assistant.js";

const ns = { kb: "t:kb", auto: "t:team:auto", knowledge: "t:team:knowledge", handover: "t:handover", personal: (u) => "t:p:" + u, customer: (c) => "t:c:" + c };
const fail = (msg, x) => {
  console.log("SMOKE FAIL:", msg, JSON.stringify(x)?.slice(0, 500));
  process.exit(1);
};

// 1) Vong lap cong cu + cau noi tiep.
{
  let n = 0;
  const answers = [
    '{"intent":"tool","tool":"callcenter_top","params":{"metric":"nhan_nhieu","period":"hom_nay"},"more":true,"topic":0,"topicLabel":"call center"}',
    '{"action":"answer","note":"Bình nhận nhiều nhất với 413 cuộc, còn An chỉ 13."}',
    '{"intent":"tool","tool":"ticket_loc","params":{"cap":"L2","nguoi_xu_ly":"Khoa L2"},"more":false,"topic":1}',
  ];
  const ask = async () => answers[n++] || "{}";
  const memory = { ns, recall: async () => [], remember: async () => ({}), analyze: async () => {} };
  const a = createAssistant({ memory, ask, askStrong: ask, knowledge: {}, directory: {}, incident: { check: async () => null }, usageLogPath: "", addendumPath: "", includePrivateKb: false, kbPointerPath: "", kbCacheDir: "", statePath: "", jiraTools: true,
    runTool: async (c) => `bang so ${c.tool} ${JSON.stringify(c.params)}\nbinh: nhận 413 | miss 40\nan: nhận 13 | miss 7` });
  const r1 = await a.handle({ chatId: "c1", userId: "u", userName: "Ha", text: "hôm nay ai nhận call nhiều nhất" });
  if (!String(r1[0]).includes("💬") || !String(r1[0]).includes("callcenter_top")) fail("vong lap cong cu", r1);
  const r2 = await a.handle({ chatId: "c1", userId: "u", userName: "Ha", text: "còn ticket L2 của Khoa L2" });
  if (!String(r2[0]).includes('"cap":"L2"') || !String(r2[0]).includes("Khoa L2")) fail("ticket_loc", r2);
}

// 2) Loi day da gop vao WF bi bo, loi day chua gop van dung.
{
  const prompts = [];
  const ask = async ({ prompt }) => {
    prompts.push(prompt || "");
    return prompts.length === 1 ? '{"intent":"ask","topic":0,"query":"Cooler Movement"}' : '{"kind":"workflow","title":"x","steps":["a","b"],"sourceRef":"WF37"}';
  };
  const h = (text, at) => ({ text, distance: 0.2, blob_id: at, meta: { author: "Ha", time: new Date(`${at.replace(" ", "T")}:00+07:00`) } });
  const memory = {
    ns,
    recall: async (n) => (n === "t:team:knowledge" ? [h("[x] [Ha] LOIDAYGOC", "2026-09-28 10:10"), h("[x] [Ha] LOIDAYCHUAGOP", "2026-09-28 09:24")] : n === "t:kb" ? [{ text: "(cập nhật 2026-09-29) WF37 delta sync", distance: 0.3, blob_id: "b3" }] : []),
    remember: async () => ({}),
    analyze: async () => {},
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/kb-merged.json", JSON.stringify({ items: [{ by: "Ha", at: "2026-09-28 10:10" }] }));
  const a = createAssistant({ memory, ask, askStrong: ask, knowledge: {}, directory: {}, incident: { check: async () => null }, usageLogPath: "", addendumPath: "", includePrivateKb: false, kbPointerPath: "", kbCacheDir: "", statePath: "", mergedPath: "/tmp/kb-merged.json" });
  await a.handle({ chatId: "c2", userId: "u", userName: "Test", text: "Cooler Movement báo mã tài sản không tìm thấy xử lý sao" });
  const p = prompts.find((x) => x.includes("WORKFLOW LIÊN QUAN")) || "";
  if (p.includes("LOIDAYGOC") || !p.includes("LOIDAYCHUAGOP") || !p.includes("WF37")) fail("loc loi day da gop", p.slice(0, 400));
}

// 3) Goi y "L1 can lam gi tiep" cho 1 ticket: doc ho so -> khung tra loi, khong do ho so ra.
{
  let n = 0;
  const answers = [
    '{"intent":"tool","tool":"ticket_goi_y","params":{"key":"SUP-159589"},"more":false,"topic":0}',
    '{"dang_o_dau":"L2 đã ra nguyên nhân thiếu mapping","dang_cho":"BSG anh Lưu, 2 ngày","l1_nen_lam":["Báo khách nguyên nhân","Nhắc anh Lưu"],"luu_y":""}',
  ];
  const ask = async () => answers[n++] || "{}";
  const memory = { ns, recall: async () => [], remember: async () => ({}), analyze: async () => {} };
  const dossier = "TICKET SUP-159589: [B2B Portal] Không tìm được mã hàng\nLink: x\nTrạng thái: Waiting for customer · Level: Level 2 · Nhóm: B2B Portal\nNgười raise (reporter): An Nguyen · Đang giữ (assignee): Khoa L2\n\nCOMMENT: NOIDUNGDAI";
  const a = createAssistant({ memory, ask, askStrong: ask, knowledge: {}, directory: {}, incident: { check: async () => null }, usageLogPath: "", addendumPath: "", includePrivateKb: false, kbPointerPath: "", kbCacheDir: "", statePath: "", jiraTools: true, runTool: async () => dossier });
  const r = await a.handle({ chatId: "c3", userId: "u", userName: "Ha", text: "ticket 159589 L1 cần làm gì tiếp" });
  if (!String(r[0]).includes("🧭") || !String(r[0]).includes("L1 nên làm") || String(r[0]).includes("NOIDUNGDAI")) fail("ticket_goi_y", r);
}

console.log("SMOKE OK");
