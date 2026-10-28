// Chi mock model/memory va thu muc tam; khong nap config, state that hay goi mang.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "./helpers.mjs";
import path from "node:path";
import { createAssistant } from "../src/assistant.js";
import { parseRouteHint } from "../src/escalation.js";
import { fmtRouteHint } from "../src/format.js";
import { MAX_RULE_DISTANCE } from "../src/routeEval.js";

const question = "FIELDGO không đăng nhập được xử lý sao?";
const workflow = {
  kind: "workflow", title: "FIELDGO lỗi đăng nhập", steps: ["Kiểm tra cấu hình"],
  escalate: "L2 Data Team khi vẫn lỗi", source: "kb", sourceRef: "WF12",
};
const rule = ({ id = "C1", system = "FIELDGO", route = "L2", target = "Data Team", count = 7, total = 8,
  percent = Math.round(count / total * 100), action = "Chuyển Data Team kèm ảnh lỗi" } = {}) => ({
  distance: Math.min(0.1, MAX_RULE_DISTANCE),
  text: `[2026-10-24 09:00] [ticket gateway] Luật chuyển tuyến [${id}] Lỗi đăng nhập (${system})\n`
    + `Thường xử lý bởi: ${route}${route === "L1" ? "" : ` ${target}`} (${count}/${total} ticket, ${percent}%), gần nhất 2026-10-23\n`
    + `L1 nên: ${action}\nCách sửa đã ghi: Sửa cấu hình\nVí dụ ticket: TEST-1\nNguồn: tự học từ ticket gateway`,
});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "l1-route-hint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Khong duoc goi mang trong test"); });
  const usageLogPath = path.join(dir, "usage.jsonl"), recalls = [], prompts = [];
  const namespace = overrides.namespace || "fake:escalation";
  const memory = {
    ns: { kb: "fake:kb", knowledge: "fake:taught", auto: "fake:auto", handover: "fake:handover",
      personal: (id) => `fake:personal:${id}`, customer: (id) => `fake:customer:${id}` },
    recall: async (...args) => {
      recalls.push(args);
      if (args[0] === namespace) return overrides.recall ? overrides.recall(...args) : overrides.rules || [rule()];
      if (overrides.docsError && args[0] === "fake:kb") throw new Error("timeout");
      return args[0] === "fake:kb" ? overrides.docs ?? [{ text: "WF12. FIELDGO — Lỗi đăng nhập\nĐiểm handover/escalation: L2 Data Team", distance: 0.1 }] : [];
    },
    analyze() {},
    remember() { assert.fail("Cau hoi khong duoc ghi luat"); },
  };
  const assistant = createAssistant({
    memory, usageLogPath, directory: {}, knowledge: {}, ...overrides.options,
    ask: async (args) => {
      prompts.push(args);
      if (args.system.startsWith("Bạn là bộ điều phối")) return JSON.stringify({ intent: overrides.intent || "ask", query: overrides.query || overrides.question || question });
      if (args.system.startsWith("Câu hỏi dưới đây tra kho")) return overrides.alt || "NONE";
      if (args.system.startsWith("Bạn phân tích câu hỏi thời tiết")) return JSON.stringify({ weather: true, query: "TEST-LOCATION", label: "Test" });
      await overrides.beforeAnswer?.();
      return JSON.stringify(overrides.response || workflow);
    },
  });
  return { assistant, recalls, prompts,
    handle: (text = overrides.question || question) => assistant.handle({ chatId: "eval-hint", userId: "l1", userName: "Tester", text }),
    logs: async () => (await readFile(usageLogPath, "utf8")).trim().split("\n").map(JSON.parse),
  };
}

test("luat lien quan them goi y vao workflow va log usage", async (t) => {
  const f = await fixture(t);
  const [reply] = await f.handle();
  assert.match(reply, /1\. Kiểm tra cấu hình/);
  assert.match(reply, /↪️ Lỗi tương tự trước đây: thường chuyển \*\*L2 Data Team\*\* \(7\/8 lần, gần nhất 23\/10\)\./);
  assert.match(reply, /L1 nên: Chuyển Data Team kèm ảnh lỗi/);
  assert.doesNotMatch(reply, /blockchain|chain|walrus|khác hướng dẫn WF/i);
  assert.deepEqual(f.recalls.find(([ns]) => ns === "fake:escalation"), ["fake:escalation", question, { limit: 5 }]);
  const [log] = await f.logs();
  assert.deepEqual(log.routeHint, { category: "Lỗi đăng nhập", route: "L2", confidence: 0.88 });
  assert.equal(log.reply, reply);
  assert.ok(f.prompts.every(({ prompt }) => !prompt.includes("Luật chuyển tuyến")));
});

test("missing va clarify deu co goi y; khong bien luat thanh cac buoc WF", async (t) => {
  for (const kind of ["missing", "clarify"]) {
    const response = kind === "missing" ? { kind } : { kind, title: "Lỗi đăng nhập", question: "Đã kiểm tra cấu hình chưa?",
      options: [{ answer: "Rồi", next: "Chuyển L2" }, { answer: "Chưa", next: "Kiểm tra cấu hình" }], sourceRef: "WF12" };
    const f = await fixture(t, { response, ...(kind === "missing" ? { docs: [] } : {}) });
    const [reply] = await f.handle();
    assert.match(reply, kind === "missing" ? /Chưa có trong tài liệu/ : /Đã kiểm tra cấu hình chưa/);
    assert.match(reply, /↪️ Lỗi tương tự trước đây/);
    assert.equal((await f.logs())[0].answer, kind);
  }
});

test("dung nguong distance v2 va bo distance xa, thieu, am, khong hop le", async (t) => {
  for (const distance of [MAX_RULE_DISTANCE, MAX_RULE_DISTANCE + 0.001, undefined, -1, NaN, "0.1"]) {
    const f = await fixture(t, { rules: [{ ...rule(), distance }] });
    const [reply] = await f.handle();
    assert.equal(reply.includes("↪️"), distance === MAX_RULE_DISTANCE, String(distance));
  }
});

test("khac he thong bi bo ke ca noi dung cach sua nhac FIELDGO; alias cung ho duoc giu", async (t) => {
  for (const [system, expected] of [["COOLERTRACK", false], ["FIELDGO Mobile", true]]) {
    const hit = rule({ system });
    hit.text += "\nCách sửa thêm: đối chiếu dữ liệu FIELDGO";
    const f = await fixture(t, { rules: [hit] });
    assert.equal((await f.handle())[0].includes("↪️"), expected);
  }
});

test("chi hien confidence >= 0.6 va total >= 2, khong nhan phan tram lam tron sai", async (t) => {
  for (const [count, total, expected] of [[1, 1, false], [1, 2, false], [3, 5, true], [596, 1000, false]]) {
    const f = await fixture(t, { rules: [rule({ count, total })] });
    assert.equal((await f.handle())[0].includes("↪️"), expected, `${count}/${total}`);
  }
  assert.equal(parseRouteHint(rule({ count: 9, total: 8 }).text), null);
  assert.equal(parseRouteHint(rule({ percent: 101 }).text), null);
  assert.equal(parseRouteHint("noi dung khong phai luat"), null);
});

test("luat Tester va ban cu cung ID khong hien, ke ca tombstone nam ngoai nguong", async (t) => {
  const revoked = { text: "[2026-10-25 10:00] [Admin] Luật [C1] đã bị Admin huỷ: sai người nhận", distance: 1.8 };
  for (const rules of [[revoked], [rule(), revoked], [{ ...rule(), text: `${rule().text}\nđã bị Admin huỷ` }]]) {
    const f = await fixture(t, { rules });
    assert.doesNotMatch((await f.handle())[0], /↪️/);
    assert.equal((await f.logs())[0].routeHint, undefined);
  }
  const f = await fixture(t, { rules: [rule(), revoked, rule({ id: "C2", target: "Tester Nguyen" })] });
  assert.match((await f.handle())[0], /thường chuyển \*\*L2 Tester Nguyen\*\*/);
});

test("recall loi/ket qua hong chi bo goi y, khong lam cau tra loi degraded", async (t) => {
  for (const recall of [async () => { throw new Error("recall failed"); }, async () => null]) {
    const f = await fixture(t, { recall });
    const [reply] = await f.handle();
    assert.match(reply, /1\. Kiểm tra cấu hình/);
    assert.doesNotMatch(reply, /↪️|Bộ nhớ đang/);
    assert.equal((await f.logs())[0].routeHint, undefined);
  }
});

test("recall chua xong khong giu cau tra loi de cho du 3s", { timeout: 1000 }, async (t) => {
  const pending = deferred();
  t.after(() => pending.resolve([rule()]));
  const f = await fixture(t, { recall: () => pending.promise });
  const [reply] = await f.handle();
  assert.match(reply, /1\. Kiểm tra cấu hình/);
  assert.doesNotMatch(reply, /↪️/);
});

test("recall ve sau 3s bi bo ngay ca khi model van dang soan cau tra loi", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const pending = deferred(), answerStarted = deferred(), finishAnswer = deferred();
  const f = await fixture(t, { recall: () => pending.promise, beforeAnswer: async () => { answerStarted.resolve(); await finishAnswer.promise; } });
  const running = f.handle();
  await answerStarted.promise;
  t.mock.timers.setTime(3001);
  pending.resolve([rule()]);
  await flush();
  finishAnswer.resolve();
  assert.doesNotMatch((await running)[0], /↪️/);
  assert.equal((await f.logs())[0].routeHint, undefined);
});

test("recall den trong 3s van hien khi model tra loi muon hon", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const pending = deferred(), answerStarted = deferred(), finishAnswer = deferred();
  const f = await fixture(t, { recall: () => pending.promise, beforeAnswer: async () => { answerStarted.resolve(); await finishAnswer.promise; } });
  const running = f.handle();
  await answerStarted.promise;
  t.mock.timers.setTime(2999);
  pending.resolve([rule()]);
  await flush();
  t.mock.timers.setTime(6000);
  finishAnswer.resolve();
  assert.match((await running)[0], /↪️/);
});

test("kind other/tieng Anh khong hien goi y du recall co luat gan", async (t) => {
  for (const text of ["Chào bạn", "Từ schedule đọc sao?", "Dịch câu FIELDGO login failed sang tiếng Việt?"]) {
    const f = await fixture(t, { question: text, response: { kind: "other", text: "Câu trả lời chung" } });
    assert.equal((await f.handle())[0], "Câu trả lời chung");
    assert.equal((await f.logs())[0].routeHint, undefined);
  }
  const f = await fixture(t, { question: "Dịch câu FIELDGO login failed nghĩa là gì?", docs: [], response: { kind: "other", text: "Đăng nhập thất bại" } });
  assert.doesNotMatch((await f.handle())[0], /↪️/);
  assert.equal((await f.logs())[0].routeHint, undefined);
});

test("nhanh thoi tiet khong recall luat, khong hien goi y", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await fixture(t, { intent: "weather", question: "Thời tiết hôm nay thế nào?" });
  assert.doesNotMatch((await f.handle())[0], /↪️/);
  assert.ok(!f.recalls.some(([ns]) => ns === "fake:escalation"));
});

test("ROUTE_HINTS mac dinh bat; env va tham so cho phep so sanh co/khong memory", async (t) => {
  const previous = process.env.ROUTE_HINTS;
  t.after(() => {
    if (previous === undefined) delete process.env.ROUTE_HINTS;
    else process.env.ROUTE_HINTS = previous;
  });
  for (const [env, options, expected] of [[undefined, {}, true], ["0", {}, false], ["false", {}, false], [" OFF ", {}, false],
    ["1", { routeHints: false }, false], ["0", { routeHints: true }, true]]) {
    if (env === undefined) delete process.env.ROUTE_HINTS;
    else process.env.ROUTE_HINTS = env;
    const f = await fixture(t, { options });
    assert.equal((await f.handle())[0].includes("↪️"), expected);
    assert.equal(f.recalls.some(([ns]) => ns === "fake:escalation"), expected);
    assert.equal(!!(await f.logs())[0].routeHint, expected);
  }
});

test("query day du va namespace tuy chinh duoc dung de recall goi y", async (t) => {
  const f = await fixture(t, { question: "Vẫn lỗi thì sao?", query: question, namespace: "custom:routes", options: { escalationNamespace: "custom:routes" } });
  assert.match((await f.handle())[0], /↪️/);
  assert.deepEqual(f.recalls.find(([ns]) => ns === "custom:routes"), ["custom:routes", question, { limit: 5 }]);
});

test("bootstrap truyen cung namespace cho goi y, learner va routeEval", async () => {
  const source = await readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function bootstrap")).replace(/^export /, "");
  const captured = {};
  const deps = {
    ROOT: "/fake-root", path, process: { env: { ESCALATION_NS: "custom:routes" } },
    loadConfig: () => ({ memwal: {}, namespacePrefix: "fake", llm: { fallbackModels: [] }, tatum: {}, incident: {}, knowledgeDir: "fake" }),
    readFile: async () => JSON.stringify({ items: [] }), createMemory: () => ({}), createLlm: () => () => {},
    loadKnowledge: async () => ({}), loadDirectory: async () => ({}), createIncidentDetector: () => ({}), createEvalRunner: () => ({}),
    createAssistant: (options) => { captured.assistant = options; return {}; },
    createEscalationLearner: (options) => { captured.learner = options; return {}; },
    createRouteEval: (options) => { captured.eval = options; return {}; },
  };
  const bootstrap = new Function("deps", `const { ${Object.keys(deps).join(", ")} } = deps;\n${body}\nreturn bootstrap;`)(deps);
  await bootstrap({ needZalo: false });
  assert.equal(captured.assistant.escalationNamespace, "custom:routes");
  assert.equal(captured.assistant.escalationNamespace, captured.learner.namespace);
  assert.equal(captured.assistant.escalationNamespace, captured.eval.namespace);
});

test("WF khac noi nhan van hien ca hai huong va canh bao Tester", async (t) => {
  const f = await fixture(t, { response: { ...workflow, escalate: "L2 Service Team khi vẫn lỗi" } });
  const [reply] = await f.handle();
  assert.match(reply, /Escalate:.*L2 Service Team khi vẫn lỗi/);
  assert.match(reply, /thường chuyển \*\*L2 Data Team\*\*/);
  assert.match(reply, /\(khác hướng dẫn WF — báo Admin kiểm\)/);
});

test("format L1/vendor, gioi han 2 dong va phan biet WF chung/cung/khac tuyen", () => {
  const l1 = parseRouteHint(rule({ route: "L1", count: 12, total: 12, action: "" }).text);
  assert.equal(fmtRouteHint(l1), "↪️ Lỗi tương tự trước đây: L1 tự xử lý được (12/12 lần).");
  const l2 = parseRouteHint(rule().text);
  for (const [escalate, expected] of [["L2 Data Team khi lỗi", false], ["L2 Data Team", false], ["L2", false],
    ["L2 Service Team", true], ["VENDOR Data Team", true], ["Không cần escalate", true]]) {
    assert.equal(fmtRouteHint(l2, { sourceRef: "WF12", escalate }).includes("khác hướng dẫn WF"), expected, escalate);
  }
  const vendor = parseRouteHint(rule({ route: "VENDOR", target: "Northwind Systems", action: "Kiểm tra\n" + "nội dung dài ".repeat(50) }).text);
  assert.match(fmtRouteHint(vendor), /thường chuyển \*\*VENDOR Northwind Systems\*\*/);
  assert.ok(fmtRouteHint(vendor).split("\n").length <= 2);
  assert.doesNotMatch(fmtRouteHint(l2, { sourceRef: "taught", escalate: "L2 Service Team" }), /khác hướng dẫn WF/);
});

test("help va thong bao degraded khong lo ten Tester tang cho L1", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t, { docsError: true, response: { kind: "missing" }, rules: [] });
  for (const text of ["/help", question]) assert.doesNotMatch((await f.handle(text))[0], /blockchain|chain|walrus/i);
});
