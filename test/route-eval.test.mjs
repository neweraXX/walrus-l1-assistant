// Chi du lieu gia, mock model/memory va thu muc tam; khong nap config hay goi mang.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "./helpers.mjs";
import path from "node:path";
import { createRouteEval, formatReport, PROMPT_VERSION, MAX_RULE_DISTANCE, SYSTEM_PROMPT, TICKET_PROMPT } from "../src/routeEval.js";
import { createEscalationLearner } from "../src/escalation.js";

const answer = (route = "L1", target = "", extra = {}) => JSON.stringify({ route, target, confidence: 0.8, reason: "Dựa trên loại lỗi", ...extra });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function fixture(t, items = [{ key: "TEST-1", label: "L1" }], overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "l1-route-eval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const labelsPath = path.join(dir, "labels.json"), textPath = path.join(dir, "text.json"), logPath = path.join(dir, "output", "route-eval.jsonl");
  const texts = { ...Object.fromEntries(items.map((x, i) => [x.key, `NOI DUNG GIA RIENG ${i + 1}`])), ...overrides.texts };
  await writeFile(labelsPath, JSON.stringify({ items: items.map((x) => ({ summary: "NHAN_KHONG_DUOC_LO", closedBy: "NGUOI_DONG_KHONG_DUOC_LO", ...x })) }));
  await writeFile(textPath, JSON.stringify({ items: texts }));
  const prompts = [], recalls = [];
  const runner = createRouteEval({
    labelsPath, textPath, logPath, gapMs: overrides.gapMs ?? 0, namespace: "fake:escalation",
    ask: async (args) => { prompts.push(args); return overrides.ask ? overrides.ask(args, prompts.length) : answer(); },
    memory: { recall: async (...args) => { recalls.push(args); return overrides.recall ? overrides.recall(...args) : []; } },
  });
  return { runner, dir, labelsPath, textPath, logPath, texts, prompts, recalls, logs: async () => (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse) };
}

test("cham route, escalate, target va unknown; prompt/log khong lo nhan hay text", async (t) => {
  const items = [
    { key: "TEST-1", label: "L1" }, { key: "TEST-2", label: "L1" },
    { key: "TEST-3", label: "L2", target: "Data Team" }, { key: "TEST-4", label: "L2", target: "DISTRIBUTORHUB team" },
    { key: "TEST-5", label: "VENDOR", target: "Northwind Systems Support" }, { key: "TEST-6", label: "VENDOR", target: "Đặng Bình" },
    { key: "TEST-7", label: "L2" }, { key: "TEST-8", label: "L1" },
  ];
  const responses = [
    answer("L1", "Bo ten L1", { reason: Array.from({ length: 25 }, (_, i) => `tu${i}`).join(" ") }),
    answer("VENDOR", "ABC"), answer("L2", "DATA.TEAM"), answer("VENDOR", "DISTRIBUTORHUB"),
    answer("VENDOR", "Northwind Systems"), answer("L1"), answer("L2"), "không biết",
  ];
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const f = await fixture(t, items, { ask: (_, n) => responses[n - 1] });
  const [result] = await f.runner.run({ modes: ["off"] });
  assert.equal(result.n, 8);
  assert.equal(result.accuracy, 0.5);
  assert.equal(result.precision, 0.8);
  assert.equal(result.recall, 0.8);
  assert.equal(result.unknown, 1);
  assert.equal(result.targetAccuracy, 0.75);
  assert.equal(result.targetMatched, 3);
  assert.equal(result.targetTotal, 4);
  assert.deepEqual(result.confusion, {
    L1: { L1: 1, L2: 0, VENDOR: 1 }, L2: { L1: 0, L2: 2, VENDOR: 1 }, VENDOR: { L1: 1, L2: 0, VENDOR: 1 },
  });
  assert.deepEqual(result.rulesSeen, []);
  assert.equal(result.tickets[0].prediction.target, "");
  assert.equal(result.tickets[0].prediction.reason.split(" ").length, 15);
  assert.equal(result.tickets[3].correct, false);
  assert.equal(result.tickets[3].targetCorrect, true);
  assert.equal(result.tickets[7].error, "invalid_prediction");
  assert.equal(f.recalls.length, 0);
  for (const [i, args] of f.prompts.entries()) {
    assert.deepEqual(Object.keys(args).sort(), ["prompt", "system"]);
    assert.equal(args.system, SYSTEM_PROMPT);
    assert.equal(args.prompt, `${TICKET_PROMPT}${f.texts[items[i].key]}`);
    assert.doesNotMatch(JSON.stringify(args), /NHAN_KHONG_DUOC_LO|NGUOI_DONG_KHONG_DUOC_LO|TEST-\d/);
  }
  const [summary] = await f.logs();
  for (const field of ["at", "mode", "maxRuleId", "promptVersion", "n", "accuracy", "precision", "recall", "confusion", "unknown", "rulesSeen"]) assert.ok(field in summary);
  assert.equal(summary.promptVersion, PROMPT_VERSION);
  assert.equal(summary.maxRuleId, null);
  assert.equal(summary.tickets, undefined);
  assert.equal(path.dirname(summary.detailsPath), path.dirname(f.logPath));
  const detailText = await readFile(summary.detailsPath, "utf8");
  assert.deepEqual(JSON.parse(detailText).tickets, result.tickets);
  const saved = JSON.stringify(summary) + detailText + errors.join("\n");
  for (const text of Object.values(f.texts)) assert.ok(!saved.includes(text));
  assert.doesNotMatch(saved, /NHAN_KHONG_DUOC_LO|NGUOI_DONG_KHONG_DUOC_LO|"label"|"summary"/);
});

test("memory recall dung namespace/text/limit, loc snapshot 10/20 va all", async (t) => {
  const rules = [
    { text: "Luật chuyển tuyến [C2] reset → L1" }, { text: "Luật chuyển tuyến [C10] đồng bộ → L2" },
    { text: "Luật chuyển tuyến [C11] MFA → VENDOR" }, { text: "Tin khong co ID" },
    { text: "Luật chuyển tuyến [C1] cu; Luật chuyển tuyến [C21] moi" },
  ].map((r) => ({ ...r, distance: MAX_RULE_DISTANCE / 2 }));
  const f = await fixture(t, undefined, { recall: async () => rules });
  const [off, memory] = await f.runner.run({ maxRuleId: 10 });
  assert.deepEqual(off.rulesSeen, []);
  assert.deepEqual(memory.rulesSeen, ["C2", "C10"]);
  assert.equal(off.tickets[0].rulesRecalled, 0);
  assert.equal(off.tickets[0].rulesKept, 0);
  assert.equal(memory.tickets[0].rulesRecalled, 5);
  assert.equal(memory.tickets[0].rulesKept, 2);
  assert.deepEqual(f.recalls[0], ["fake:escalation", f.texts["TEST-1"], { limit: 5 }]);
  assert.equal(f.prompts[0].system, f.prompts[1].system);
  assert.doesNotMatch(f.prompts[0].prompt, /LUẬT ĐÃ HỌC/);
  assert.match(f.prompts[1].prompt, /LUẬT ĐÃ HỌC:\nLuật chuyển tuyến \[C2\]/);
  assert.match(f.prompts[1].prompt, /\[C10\]/);
  assert.doesNotMatch(f.prompts[1].prompt, /\[C11\]|\[C21\]|Tin khong co ID/);
  const [twenty] = await f.runner.run({ modes: ["memory"], maxRuleId: 20 });
  assert.deepEqual(twenty.rulesSeen, ["C2", "C10", "C11"]);
  const [all] = await f.runner.run({ modes: ["memory"] });
  assert.deepEqual(all.rulesSeen, ["C1", "C2", "C10", "C11", "C21"]);
  const logs = await f.logs();
  assert.equal(logs.length, 4);
  assert.equal(new Set(logs.map((r) => r.detailsPath)).size, 4);
  assert.deepEqual(logs.map((r) => r.maxRuleId), [10, 10, 20, null]);
  assert.ok((await readFile(logs[0].detailsPath, "utf8")).includes("TEST-1"));
});

test("loc distance <= nguong, bo distance thieu/khong hop le; log co dem va giu v1", async (t) => {
  const text = "Luật chuyển tuyến [C1] Lỗi chung (-)\nThường xử lý bởi: L1";
  const rules = [
    { text, distance: 0 }, { text, distance: MAX_RULE_DISTANCE },
    ...[MAX_RULE_DISTANCE + 0.01, -0.01, NaN, Infinity, "0.1", null, undefined].map((distance) => ({ text, distance })),
    text,
  ];
  const f = await fixture(t, undefined, { recall: () => rules });
  const [off] = await f.runner.run({ modes: ["off"] });
  // Chi log gia o thu muc tam; dong v1 phai duoc giu nguyen khi v2 append.
  const v1 = `${JSON.stringify({ promptVersion: "route-eval-v1", mode: "memory", accuracy: 0.368 })}\n`;
  await writeFile(f.logPath, v1);
  const [memory] = await f.runner.run({ modes: ["memory"] });
  assert.equal(PROMPT_VERSION, "route-eval-v2");
  assert.equal(memory.tickets[0].rulesRecalled, 10);
  assert.equal(memory.tickets[0].rulesKept, 2);
  assert.deepEqual(memory.rulesSeen, ["C1"]);
  const log = await readFile(f.logPath, "utf8");
  assert.ok(log.startsWith(v1));
  const summaries = log.trim().split("\n").map(JSON.parse);
  assert.deepEqual(summaries.map((r) => r.promptVersion), ["route-eval-v1", "route-eval-v2"]);
  assert.equal(summaries[1].maxRuleDistance, MAX_RULE_DISTANCE);
  const detail = JSON.parse(await readFile(memory.detailsPath, "utf8"));
  assert.equal(detail.maxRuleDistance, MAX_RULE_DISTANCE);
  assert.equal(detail.tickets[0].rulesRecalled, 10);
  assert.equal(detail.tickets[0].rulesKept, 2);
  const offDetail = JSON.parse(await readFile(off.detailsPath, "utf8"));
  assert.equal(offDetail.tickets[0].rulesRecalled, 0);
  assert.equal(offDetail.tickets[0].rulesKept, 0);
});

test("loc he thong tu tag/tu khoa, alias va tieu de luat; cho phep he thong rong", async (t) => {
  const rules = [
    "Luật chuyển tuyến [C1] Lỗi chung (FIELDGO Mobile)\nL1 nên: Mở COOLERTRACK kiểm tra",
    "[2026-10-24 18:00] [ticket gateway] Luật chuyển tuyến [C2] Lỗi chung (COOLERTRACK Portal)\nL1 nên: Kiểm tra FIELDGO",
    "Luật chuyển tuyến [C3] Lỗi chung (ORDERPORTAL)",
    "Luật chuyển tuyến [C4] Lỗi chung (-)",
    "Luật chuyển tuyến [C5] Lỗi chung ()",
    "Luật chuyển tuyến [C6] Lỗi chung",
    "Luật chuyển tuyến [C7] Lỗi chung (APP-MOI)",
    "Luật chuyển tuyến [C8] Lỗi chung (DISTRIBUTORHUB)",
    "Luật chuyển tuyến [C9] Lỗi chung (DEVICEHUB)",
    "Luật chuyển tuyến [C10] Lỗi chung (INSIGHTHUB)",
    "Luật chuyển tuyến [C11] Lỗi chung (ContractDesk)",
    "Luật chuyển tuyến [C12] Lỗi chung (Customer Tax)",
  ].map((text) => ({ text, distance: MAX_RULE_DISTANCE / 2 }));
  const generic = ["C4", "C5", "C6"];
  const cases = [
    ["[FIELDGO] Lỗi chung", ["C1", ...generic]],
    ["Ứng dụng FIELDGO lỗi chung", ["C1", ...generic]],
    ["[COOLERTRACK] Lỗi chung", ["C2", ...generic]],
    ["COOLERTRACK tablet lỗi chung", ["C2", ...generic]],
    ["[ORDERPORTAL] Lỗi chung", ["C3", ...generic]],
    ["OrderPortal lỗi chung", ["C3", ...generic]],
    ["[APP-MOI] Lỗi chung", [...generic, "C7"]],
    ["[DISTRIBUTORHUB] Lỗi chung", [...generic, "C8"]],
    ["DEVICEHUB lỗi chung", [...generic, "C9"]],
    ["INSIGHTHUB lỗi chung", [...generic, "C10"]],
    ["ContractDesk lỗi chung", [...generic, "C11"]],
    ["Customer Tax lỗi chung", [...generic, "C12"]],
    ["Lỗi chung [email] [SĐT] [mã] [C99]", rules.map((_, i) => `C${i + 1}`)],
    ["XCOOLERTRACKX AFIELDGOS EORDERPORTALX lỗi chung", rules.map((_, i) => `C${i + 1}`)],
  ];
  for (const [text, expected] of cases) {
    const f = await fixture(t, undefined, { texts: { "TEST-1": text }, recall: () => rules });
    const [result] = await f.runner.run({ modes: ["memory"] });
    assert.deepEqual(result.rulesSeen, expected, text);
    assert.equal(result.tickets[0].rulesKept, expected.length, text);
  }
});

test("loc het luat thi memory giong off; mo ta 3 tuyen/cung loai ap dung ca hai", async (t) => {
  const f = await fixture(t, undefined, {
    texts: { "TEST-1": "[FIELDGO] Lỗi chung" },
    recall: () => [
      { text: "Luật chuyển tuyến [C1] Lỗi chung (FIELDGO)", distance: MAX_RULE_DISTANCE + 0.01 },
      { text: "Luật chuyển tuyến [C2] Lỗi chung (COOLERTRACK)", distance: 0 },
    ],
    ask: ({ prompt }) => answer(prompt.includes("LUẬT ĐÃ HỌC") ? "L1" : "VENDOR", "Đối tác test"),
  });
  const [off, memory] = await f.runner.run();
  assert.deepEqual(f.prompts[0], f.prompts[1]);
  assert.deepEqual(memory.tickets[0].prediction, off.tickets[0].prediction);
  assert.equal(memory.tickets[0].prediction.route, "VENDOR");
  assert.equal(memory.tickets[0].rulesRecalled, 2);
  assert.equal(memory.tickets[0].rulesKept, 0);
  assert.deepEqual(memory.rulesSeen, []);
  assert.match(f.prompts[0].system, /Chỉ áp dụng luật nếu CÙNG loại lỗi; nếu không có luật cùng loại thì tự suy luận như không có luật\./);
  for (const description of ["L1 tự xử lý (hướng dẫn, reset, cấu hình đơn giản)", "L2 nội bộ (dữ liệu/hệ thống cần quyền cao)", "VENDOR (lỗi/thay đổi phía nhà cung cấp phần mềm, tài khoản do vendor quản lý)"]) {
    assert.ok(f.prompts[0].system.includes(description));
  }
});

test("MAX_RULE_DISTANCE mac dinh 0.5, override env va tu choi cau hinh sai", async () => {
  const previous = process.env.MAX_RULE_DISTANCE;
  let serial = 0;
  const reload = () => import(`../src/routeEval.js?distance-test=${serial++}`);
  try {
    delete process.env.MAX_RULE_DISTANCE;
    assert.equal((await reload()).MAX_RULE_DISTANCE, 0.5);
    for (const value of ["0", "0.2", "2"]) {
      process.env.MAX_RULE_DISTANCE = value;
      assert.equal((await reload()).MAX_RULE_DISTANCE, Number(value));
    }
    for (const value of ["bad", "-0.1", "2.1", "Infinity"]) {
      process.env.MAX_RULE_DISTANCE = value;
      await assert.rejects(reload(), /MAX_RULE_DISTANCE/);
    }
  } finally {
    if (previous === undefined) delete process.env.MAX_RULE_DISTANCE;
    else process.env.MAX_RULE_DISTANCE = previous;
  }
});

test("recall loi thanh unknown, ghi ma loi va tiep tuc ticket sau", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  const f = await fixture(t, [{ key: "TEST-1", label: "L2", target: "Data Team" }, { key: "TEST-2", label: "L1" }], {
    recall: async (_, text) => { if (text.endsWith("1")) throw new Error(`SDK LOI KEM TEXT ${text}`); return []; },
  });
  const [r] = await f.runner.run({ modes: ["memory"] });
  assert.equal(r.n, 2);
  assert.equal(r.unknown, 1);
  assert.equal(r.accuracy, 0.5);
  assert.equal(r.precision, 0);
  assert.equal(r.recall, 0);
  assert.equal(r.targetAccuracy, 0);
  assert.equal(r.tickets[0].error, "recall_failed");
  assert.equal(r.tickets[0].prediction.route, null);
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(r.rulesSeen, []);
  const detail = await readFile(r.detailsPath, "utf8");
  assert.match(detail, /recall_failed/);
  assert.ok(errors.some((x) => x.includes("TEST-1: recall_failed")));
  assert.doesNotMatch(errors.join(" ") + detail, /SDK LOI KEM TEXT|NOI DUNG GIA RIENG/);
});

test("loi model/JSON/confidence va thieu text khong fallback sang nhan", async (t) => {
  t.mock.method(console, "error", () => {});
  const items = Array.from({ length: 7 }, (_, i) => ({ key: `TEST-${i + 1}`, label: "L2", target: "Đặng Bình" }));
  const f = await fixture(t, items, { ask: async (_, n) => {
    if (n === 1) throw new Error("MODEL LOI");
    if (n === 2) return "{invalid}";
    if (n === 3) return answer("L2", "Dang Binh", { confidence: 1.1 });
    if (n === 4) return answer("L2", "Dang Binh", { confidence: "0.9" });
    if (n === 5) return answer("BAD");
    return `\`\`\`json\n${answer("L2", "DANG BINH")}\n\`\`\``;
  } });
  delete f.texts["TEST-7"];
  await writeFile(f.textPath, JSON.stringify({ items: f.texts }));
  const [r] = await f.runner.run({ modes: ["off"] });
  assert.equal(r.n, 7);
  assert.equal(r.unknown, 6);
  assert.equal(r.accuracy, 1 / 7);
  assert.equal(r.targetAccuracy, 1 / 7);
  assert.equal(r.tickets[0].error, "ask_failed");
  assert.equal(r.tickets[5].targetCorrect, true);
  assert.equal(r.tickets[6].error, "missing_text");
  assert.equal(f.prompts.length, 6);
});

test("gian gapMs giua hai mode, khong cho sau ask cuoi", async (t) => {
  const recallReady = deferred(), first = deferred(), second = deferred(), times = [];
  const f = await fixture(t, undefined, {
    gapMs: 13_000,
    ask: async (_, n) => { times.push(Date.now()); (n === 1 ? first : second).resolve(); return answer(); },
    recall: async () => { recallReady.resolve(); return []; },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const running = f.runner.run();
  await first.promise;
  await recallReady.promise;
  await flush();
  t.mock.timers.tick(12_999);
  await flush();
  assert.equal(times.length, 1);
  t.mock.timers.tick(1);
  await second.promise;
  await running;
  assert.deepEqual(times, [0, 13_000]);
});

test("chan run chong, mo khoa sau loi va tu choi tham so sai", async (t) => {
  const ready = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, undefined, { ask: async () => { ready.resolve(); await release.promise; return answer(); } });
  const running = f.runner.run({ modes: ["off"] });
  await ready.promise;
  await assert.rejects(f.runner.run(), /Đang đo chuyển tuyến/);
  release.resolve();
  await running;
  await writeFile(f.labelsPath, "{}");
  await assert.rejects(f.runner.run(), /holdout khong hop le/);
  await writeFile(f.labelsPath, JSON.stringify({ items: [{ key: "TEST-1", label: "L1" }] }));
  assert.equal((await f.runner.run({ modes: ["off"] }))[0].accuracy, 1);
  for (const maxRuleId of [0, -1, 1.5, "10", NaN, Infinity]) await assert.rejects(f.runner.run({ maxRuleId }), /maxRuleId/);
  for (const modes of [[], ["bad"], ["off", "off"]]) await assert.rejects(f.runner.run({ modes }), /modes/);
});

test("holdout bi bo qua truoc max, khong doc ho so/ask/memory, seen=holdout qua restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "l1-holdout-exclude-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "learner.json");
  await writeFile(statePath, JSON.stringify({ seen: { "HOLD-2": "counted" } }));
  const excluded = new Set(["HOLD-1", "HOLD-2", "HOLD-3"]), calls = [], prompts = [], writes = [];
  const options = {
    namespace: "fake:escalation", statePath, excludeKeys: excluded, llmGapMs: 0,
    runTool: async ({ tool, params }) => {
      if (tool === "ticket_da_dong") return ["HOLD-1", "HOLD-2", "HOLD-1", "TRAIN-1", "TRAIN-2"].map((key) => `${key} | FIELDGO | Level 2 | Data Team | 2026-10-24 | Đã đóng`).join("\n");
      assert.ok(!excluded.has(params.key));
      calls.push(params.key);
      return "Ho so gia cua ticket train";
    },
    ask: async (args) => { prompts.push(args); return JSON.stringify({ system: "FIELDGO", category: "Lỗi test", symptom: "Không chạy", route: "L2", target: "Data Team", l1Action: "Chuyển Data Team", fix: "" }); },
    memory: { remember: async (ns, text) => { writes.push({ ns, text }); return {}; } },
  };
  const learner = createEscalationLearner(options);
  assert.equal((await learner.runDaily({ max: 1 })).checked, 1);
  assert.deepEqual(calls, ["TRAIN-1"]);
  assert.equal((await learner.runDaily({ max: 1 })).checked, 1);
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  for (const key of excluded) assert.equal(saved.seen[key], "holdout");
  assert.deepEqual(calls, ["TRAIN-1", "TRAIN-2"]);
  assert.equal(prompts.length, 2);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(JSON.stringify(prompts) + JSON.stringify(writes), /HOLD-/);
  assert.equal(saved.routes["Lỗi test"].total, 2);
  const restarted = createEscalationLearner(options);
  assert.equal((await restarted.runDaily()).checked, 0);
  assert.equal(prompts.length, 2);
  const rules = await restarted.listRules();
  assert.deepEqual(rules[0].examples, ["TRAIN-1", "TRAIN-2"]);
});

test("formatReport tieng Viet <=12 dong, so off/memory va ma tran", async (t) => {
  const f = await fixture(t, undefined, { ask: (_, n) => answer(n === 1 ? "L2" : "L1") });
  const results = await f.runner.run();
  const report = formatReport(results);
  assert.ok(report.split("\n").length <= 12);
  assert.match(report, /off \(không nhớ\): đúng tuyến 0.0%/);
  assert.match(report, /memory \(có nhớ\): đúng tuyến 100.0%/);
  assert.match(report, /\+100.0 điểm %/);
  assert.match(report, /không biết 0\/1/);
  assert.match(report, /precision \/ recall/);
  assert.match(report, /Tên nơi nhận khớp/);
  assert.match(report, /Ma trận/);
  assert.match(report, /off: L1 0\/1\/0/);
  assert.match(report, /memory: L1 1\/0\/0/);
  assert.match(formatReport([]), /Chưa có/);
  assert.ok(f.runner.formatReport([results[1]]).split("\n").length <= 12);
});

test("/do chi admin DM, nhan so/all, chan chong va mo khoa sau loi", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function onMessage("), end = source.indexOf('\nconsole.log(`L1 Assistant san sang', start);
  const runnerStart = source.indexOf("let routeEvalRunning = false;"), runnerEnd = source.indexOf("// Lich admin", runnerStart);
  assert.ok(start >= 0 && end > start && runnerStart >= 0 && runnerEnd > runnerStart);
  const calls = [], sent = [], ready = deferred(), release = deferred();
  let block = false, fail = false;
  const deps = {
    cfg: { allowedDmUserIds: ["owner"], allowedChatIds: ["zgr-test"] }, admins: ["admin"], family: new Set(),
    // Tinh nang nhac ho (26/10) chay rieng, gia lap rong o day.
    famRem: { learnContact() {}, handleTargetReply: async () => null, handleOwner: async () => null }, rememberFamily: () => {}, botName: "", chain: null, sendProof: () => {},
    resolveText: (text) => text, withProofContext: (_, fn) => fn(),
    assistant: { handle: async () => [], handleGeneralText: async () => [] },
    zalo: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } },
    routeEval: {
      run: async (options) => { calls.push(options); if (block) { ready.resolve(); await release.promise; } if (fail) throw new Error("fake failure"); return []; },
      formatReport: () => "BAO CAO GIA",
    },
  };
  const onMessage = new Function("deps", `const { ${Object.keys(deps).join(", ")} } = deps;\n${source.slice(runnerStart, runnerEnd)}\n${source.slice(start, end)}\nreturn onMessage;`)(deps);
  const msg = (from, text, chatId = from) => ({ chat: { id: chatId }, from: { id: from, display_name: "Test" }, text });
  await onMessage(msg("owner", "/do all"));
  await onMessage(msg("admin", "/do 10", "zgr-test"));
  assert.equal(calls.length, 0);
  for (const text of ["/do", "/do ALL", "/do 10", "/do 20"]) await onMessage(msg("admin", text));
  assert.deepEqual(calls, [null, null, 10, 20].map((maxRuleId) => ({ modes: ["off", "memory"], maxRuleId })));
  for (const text of ["/do 0", "/do -1", "/do 1.5", "/do abc", "/do 10 x", "/do 9999999999999999999999"]) await onMessage(msg("admin", text));
  assert.equal(calls.length, 4);
  assert.equal(sent.filter((x) => x.text.startsWith("Cú pháp")).length, 6);
  block = true;
  const first = onMessage(msg("admin", "/do 10"));
  await ready.promise;
  await onMessage(msg("admin", "/do 20"));
  assert.equal(calls.length, 5);
  assert.match(sent.at(-1).text, /đợi lượt trước/);
  release.resolve();
  await first;
  block = false; fail = true;
  await onMessage(msg("admin", "/do"));
  assert.match(sent.at(-1).text, /Đo chuyển tuyến lỗi/);
  fail = false;
  await onMessage(msg("admin", "/do all"));
  assert.equal(sent.at(-1).text, "BAO CAO GIA");
  assert.ok(sent.every((x) => x.chatId === "admin"));
});

test("bootstrap nap keys, env paths, namespace va model co dinh; chi bo qua ENOENT", async () => {
  const source = await readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function bootstrap")).replace(/^export /, "");
  const build = (env = {}, read = async () => JSON.stringify({ items: [{ key: "HOLD-1" }, { key: "HOLD-2" }] })) => {
    const llms = [], reads = [], captured = {};
    const cfg = { memwal: {}, namespacePrefix: "fake", llm: { model: "fixed", fallbackModels: ["strong"] }, tatum: { apiKey: "" }, incident: {}, knowledgeDir: "fake" };
    const deps = {
      ROOT: "/fake-root", path, process: { env },
      loadConfig: () => cfg, readFile: async (...args) => { reads.push(args); return read(...args); },
      createMemory: () => ({}), createLlm: (options) => { const ask = () => {}; llms.push({ options, ask }); return ask; },
      loadKnowledge: async () => ({}), loadDirectory: async () => ({}), createIncidentDetector: () => ({}),
      createAssistant: () => ({}), createEvalRunner: () => ({}),
      createEscalationLearner: (options) => { captured.escalation = options; return {}; },
      createRouteEval: (options) => { captured.eval = options; return { fake: true }; },
    };
    const bootstrap = new Function("deps", `const { ${Object.keys(deps).join(", ")} } = deps;\n${body}\nreturn bootstrap;`)(deps);
    return { bootstrap, captured, reads, llms };
  };
  const f = build();
  assert.deepEqual((await f.bootstrap({ needZalo: false })).routeEval, { fake: true });
  assert.deepEqual([...f.captured.escalation.excludeKeys], ["HOLD-1", "HOLD-2"]);
  assert.deepEqual(f.reads, [["/fake-root/eval/holdout/holdout-labels.json", "utf8"]]);
  assert.equal(f.captured.eval.textPath, "/fake-root/eval/holdout/holdout-text.json");
  assert.equal(f.captured.eval.logPath, "/fake-root/logs/route-eval.jsonl");
  assert.equal(f.captured.eval.namespace, f.captured.escalation.namespace);
  const fixed = f.llms.find((x) => x.ask === f.captured.eval.ask);
  assert.equal(fixed.options.model, "fixed");
  assert.deepEqual(fixed.options.fallbackModels, []);
  const custom = build({ HOLDOUT_LABELS: "/tmp/custom-labels.json", HOLDOUT_TEXT: "custom-text.json", ESCALATION_NS: "custom:routes" }, async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  await custom.bootstrap();
  assert.equal(custom.captured.escalation.excludeKeys.size, 0);
  assert.equal(custom.captured.eval.labelsPath, "/tmp/custom-labels.json");
  assert.equal(custom.captured.eval.textPath, "/fake-root/custom-text.json");
  assert.equal(custom.captured.eval.namespace, "custom:routes");
  for (const data of ["{invalid}", "{}", '{"items":[{}]}']) await assert.rejects(build({}, async () => data).bootstrap());
  await assert.rejects(build({}, async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }).bootstrap(), /denied/);
});
