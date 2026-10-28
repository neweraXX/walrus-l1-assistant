// Chi dung du lieu gia va thu muc tam, khong khoi dong bot hay goi mang.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "./helpers.mjs";
import path from "node:path";
import { createEscalationLearner } from "../src/escalation.js";
import { createProof, withProofContext } from "../src/proof.js";
import { fmtProof, fmtTaught } from "../src/format.js";

const rule = {
  system: "FIELDGO", category: "Lỗi đăng nhập", symptom: "Không đăng nhập được",
  route: "L2", target: "Data Team", l1Action: "Chuyển Data Team kèm ảnh lỗi", fix: "Sửa cấu hình",
};
const ticket = (num, fields = {}) => ({ key: `TEST-${num}`, level: "Level 2", assignee: "Data Team", ...fields });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function fixture(t, tickets = [ticket(1), ticket(2)], initial, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "l1-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "learner.json");
  if (initial) await writeFile(statePath, JSON.stringify(initial));
  const writes = [], proofs = [], prompts = [], dossiers = [], lists = [];
  const control = { failWrites: 0 };
  const learner = createEscalationLearner({
    namespace: "test:escalation", statePath, llmGapMs: 0,
    runTool: async ({ tool, params }) => {
      if (tool === "ticket_da_dong") {
        lists.push(params);
        return tickets.map((x) => `${x.key} | ${x.group || "FIELDGO"} | ${x.level} | ${x.assignee} | ${x.date || "2026-10-24"} | Đã đóng`).join("\n");
      }
      assert.equal(tool, "ticket_goi_y");
      dossiers.push(params.key);
      const x = tickets.find((x) => x.key === params.key);
      if (x.dossierError) throw new Error("Khong doc duoc ticket");
      return x.dossier || `Ticket ${params.key}: Data Team sửa cấu hình.`;
    },
    ask: async (args) => {
      prompts.push(args);
      const x = tickets.find((x) => args.prompt.includes(`TICKET: ${x.key}\n`));
      await overrides.beforeAsk?.(x);
      return x.json ?? JSON.stringify({ ...rule, ...x.rule });
    },
    memory: { remember: async (namespace, text) => {
      if (control.failWrites > 0) { control.failWrites--; throw new Error("job failed"); }
      writes.push({ namespace, text });
      return { job: { job_id: `job-${writes.length}` }, done: Promise.resolve({ blob_id: `blob-${writes.length}` }) };
    } },
    proof: { confirm: async (write, meta) => {
      proofs.push({ write, meta });
      return overrides.confirm ? overrides.confirm(write, meta) : { ok: true, status: "confirmed", ...meta };
    } },
  });
  return { learner, tickets, writes, proofs, prompts, dossiers, lists, control, state: async () => JSON.parse(await readFile(statePath, "utf8")) };
}

test("ticket L1 don le chi cong don, khong tao memory hay de xuat", async (t) => {
  const f = await fixture(t, [ticket(1, { level: "Level 1", rule: { route: "L1", target: "Ten phai bo" } })]);
  const out = await f.learner.runDaily();
  const saved = await f.state(), r = saved.routes[rule.category];
  assert.equal(out.checked, 1);
  assert.deepEqual(r.counts, { L1: 1 });
  assert.equal(r.id, "C1");
  assert.equal(r.rememberedAt, null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.proofs.length, 0);
  assert.deepEqual(await f.learner.listRules(), []);
  for (const key of ["pending", "proposals", "patterns"]) assert.equal(key in saved, false);
  await f.learner.runDaily();
  assert.equal(f.prompts.length, 1);
  f.tickets.push(ticket(2, { level: "Level 1", rule: { route: "L1", target: "" } }));
  await f.learner.runDaily();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].text, /Thường xử lý bởi: L1 \(2\/2 ticket/);
});

test("2 ticket cung loai cung route ghi 1 memory, proof nen va marker qua restart", async (t) => {
  const f = await fixture(t, undefined, undefined, { confirm: () => new Promise(() => {}) });
  const out = await f.learner.runDaily();
  await flush();
  assert.equal(f.writes.length, 1);
  assert.equal(f.proofs.length, 1);
  assert.equal(f.writes[0].namespace, "test:escalation");
  assert.match(f.writes[0].text, /Luật chuyển tuyến \[C1\] Lỗi đăng nhập \(FIELDGO\)/);
  assert.match(f.writes[0].text, /L2 Data Team \(2\/2 ticket, 100%\), gần nhất 2026-10-24/);
  assert.match(f.writes[0].text, /Ví dụ ticket: TEST-1, TEST-2\nNguồn: tự học từ ticket gateway/);
  assert.equal(f.proofs[0].meta.namespace, "test:escalation");
  assert.equal(f.proofs[0].write.job.job_id, "job-1");
  const saved = await f.state(), r = saved.routes[rule.category];
  assert.deepEqual(r.counts, { "L2:Data Team": 2 });
  assert.equal(r.rememberedRoute, "L2:Data Team");
  assert.equal(r.rememberedTotal, 2);
  assert.ok(Date.parse(r.rememberedAt));
  const rules = await f.learner.listRules();
  assert.deepEqual(rules, [{ category: rule.category, route: "L2:Data Team", confidence: 1, total: 2, l1Action: rule.l1Action, examples: ["TEST-1", "TEST-2"] }]);
  rules[0].examples.push("TEST-999");
  assert.equal((await f.learner.listRules())[0].examples.length, 2);
  assert.equal(out.categories, 1);
  assert.equal(out.total, 1);
  assert.match(f.prompts[1].prompt, /LOẠI LỖI ĐÃ CÓ[^]*- Lỗi đăng nhập/);
  const restarted = await fixture(t, [ticket(1), ticket(2)], saved);
  await restarted.learner.runDaily();
  assert.equal(restarted.prompts.length, 0);
  assert.equal(restarted.writes.length, 0);
});

test("nguong dau can confidence >= 0.6, listRules tra loai active total >= 2", async (t) => {
  const f = await fixture(t, [ticket(1), ticket(2, { rule: { route: "VENDOR", target: "Doi tac A" } })]);
  await f.learner.runDaily();
  assert.equal(f.writes.length, 0);
  assert.deepEqual(await f.learner.listRules(), []);
  f.tickets.push(ticket(3, { rule: { route: "VENDOR", target: "Doi tac A" } }));
  await f.learner.runDaily();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].text, /2\/3 ticket, 67%/);
});

test("milestones do not publish rules below the reliability threshold", async (t) => {
  const f = await fixture(t, [ticket(1), ticket(2, { rule: { route: "VENDOR", target: "Doi tac A" } }), ticket(3, { rule: { route: "VENDOR", target: "Doi tac B" } })]);
  const out = await f.learner.runDaily();
  assert.equal(f.writes.length, 0);
  assert.deepEqual(await f.learner.listRules(), []);
  assert.equal(out.changes[0].reason, "MỚI");
});

test("route troi doi thi ghi moi, hoa khong doi route da nho", async (t) => {
  const f = await fixture(t);
  await f.learner.runDaily();
  f.tickets.push(...[3, 4].map((n) => ticket(n, { rule: { route: "VENDOR", target: "Doi tac A" } })));
  await f.learner.runDaily();
  assert.equal(f.writes.length, 1); // tied routes are below the reliability threshold
  assert.equal((await f.state()).routes[rule.category].rememberedRoute, "L2:Data Team");
  f.tickets.push(ticket(5, { rule: { route: "VENDOR", target: "Doi tac A" } }));
  const out = await f.learner.runDaily();
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[1].text, /VENDOR Doi tac A \(3\/5 ticket, 60%\)/);
  assert.equal((await f.state()).routes[rule.category].rememberedRoute, "VENDOR:Doi tac A");
  assert.equal(out.changes[0].reason, "ĐỔI");
});

test("1 luot 30 ticket chi ghi 1 lan (trang thai cuoi), gioi han examples/fixes va giu action khong rong", async (t) => {
  const tickets = Array.from({ length: 30 }, (_, n) => ticket(n + 1, { date: n ? "2026-10-23" : "2026-10-24", rule: { fix: `Sua ${n + 1}`, l1Action: n === 29 ? "" : `Buoc ${n + 1}` } }));
  const f = await fixture(t, tickets);
  const out = await f.learner.runDaily();
  assert.equal(out.checked, 30);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes.map((w) => Number(w.text.match(/\((\d+)\/\d+ ticket/)[1])), [30]);
  const r = (await f.state()).routes[rule.category];
  assert.equal(r.total, 30);
  assert.equal(r.lastDate, "2026-10-24");
  assert.deepEqual(r.examples, [26, 27, 28, 29, 30].map((n) => `TEST-${n}`));
  assert.deepEqual(r.fixes, ["Sua 28", "Sua 29", "Sua 30"]);
  assert.equal(r.l1Action, "Buoc 29");
  assert.equal(r.rememberedTotal, 30);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].reason, "MỚI");
});

test("backfill 14 ngay nhieu luot toi da 30, bo seen/trung key truoc limit va giu qua restart", async (t) => {
  const tickets = [ticket(0), ...Array.from({ length: 65 }, (_, i) => ticket(i + 1)), ticket(30), ticket(31)];
  const f = await fixture(t, tickets, { seen: { "TEST-0": "counted" } });
  const counts = [];
  for (let i = 0; i < 4; i++) counts.push((await f.learner.runDaily({ days: 14, max: 100 })).checked);
  assert.deepEqual(counts, [30, 30, 5, 0]);
  assert.deepEqual(f.lists, Array.from({ length: 4 }, () => ({ days: 14 })));
  assert.equal(f.dossiers.length, 65);
  assert.equal(new Set(f.dossiers).size, 65);
  assert.ok(!f.dossiers.includes("TEST-0"));
  assert.equal(f.prompts.length, 65);
  const saved = await f.state();
  assert.equal(saved.routes[rule.category].total, 65);
  assert.equal(Object.keys(saved.seen).length, 66);
  const restarted = await fixture(t, tickets, saved);
  assert.equal((await restarted.learner.runDaily({ days: 14 })).checked, 0);
  assert.equal(restarted.dossiers.length, 0);
  assert.equal(restarted.prompts.length, 0);
});

test("runDaily mac dinh 2 ngay, chan cua so o 14 va tu choi tham so sai truoc tool", async (t) => {
  const f = await fixture(t, []);
  await f.learner.runDaily();
  await f.learner.runDaily({ days: 30 });
  assert.deepEqual(f.lists, [{ days: 2 }, { days: 14 }]);
  for (const field of ["days", "max"]) {
    for (const value of [0, -1, 1.5, "14", NaN, Infinity]) {
      await assert.rejects(f.learner.runDaily({ [field]: value }), new RegExp(field));
    }
  }
  assert.equal(f.lists.length, 2);
});

test("Level 2 khong the la L1; vendor duoc giu va prompt co Level/nguoi giu cuoi", async (t) => {
  const f = await fixture(t, [ticket(1, { rule: { route: "L1", target: "" } }), ticket(2, { rule: { route: "VENDOR", target: "Doi tac A", category: "Lỗi đồng bộ" } })]);
  await f.learner.runDaily();
  const saved = await f.state();
  assert.deepEqual(saved.routes[rule.category].counts, { "L2:Data Team": 1 });
  assert.deepEqual(saved.routes["Lỗi đồng bộ"].counts, { "VENDOR:Doi tac A": 1 });
  assert.match(f.prompts[0].prompt, /Level: Level 2\nNgười giữ cuối: Data Team/);
  assert.match(f.prompts[0].system, /Level 2[^]*KHÔNG phải L1/);
  assert.match(f.prompts[0].system, /route=VENDOR[^]*đối tác bên ngoài/);
});

test("#sai chan va chi ghi 1 memory Tester, restart van chan; #mo bo chan", async (t) => {
  const f = await fixture(t);
  await f.learner.runDaily();
  await Promise.all([f.learner.handleReply("#sai C1 Sai liên hệ 0901234567", "Admin"), f.learner.handleReply("#sai c1 trùng", "Admin")]);
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[1].text, /Luật \[C1\] đã bị Admin huỷ: Sai liên hệ \[SĐT\]/);
  assert.doesNotMatch(f.writes[1].text, /0901234567/);
  assert.deepEqual(await f.learner.listRules(), []);
  const restarted = await fixture(t, Array.from({ length: 8 }, (_, n) => ticket(n + 3, { rule: { route: "VENDOR", target: "Doi tac A" } })), await f.state());
  await restarted.learner.runDaily();
  assert.equal(restarted.writes.length, 0);
  assert.equal((await restarted.state()).routes[rule.category].total, 10);
  assert.equal((await restarted.state()).routes[rule.category].status, "blocked");
  await restarted.learner.handleReply("#C1 Bo sung khi dang chan", "Admin");
  assert.equal(restarted.writes.length, 0);
  await restarted.learner.handleReply("#mo c1", "Admin");
  assert.equal((await restarted.state()).routes[rule.category].status, "active");
  assert.equal((await restarted.learner.listRules()).length, 1);
  await restarted.learner.runDaily();
  assert.equal(restarted.writes.length, 1);
  assert.match(restarted.writes[0].text, /VENDOR Doi tac A/);
});

test("#sai truoc lan nho dau khong ghi Tester, ticket tiep va ghi chu deu khong ghi", async (t) => {
  const f = await fixture(t, [ticket(1)]);
  await f.learner.runDaily();
  await f.learner.handleReply("#sai C1", "Admin");
  f.tickets.push(ticket(2), ticket(3));
  await f.learner.runDaily();
  await f.learner.handleReply("#C1 Kiem tra lai", "Admin");
  assert.equal(f.writes.length, 0);
  assert.equal(f.proofs.length, 0);
});

test("#C7 ghi ngay, them fix va uu tien l1Action cua Tester qua cac luot hoc", async (t) => {
  const f = await fixture(t, undefined, { nextId: 7 });
  await f.learner.runDaily();
  const callbacks = [];
  assert.match(await f.learner.handleReply("#c7 Kiểm tra mapping trước khi chuyển", "Admin", { onProof: (r) => callbacks.push(r) }), /Đã bổ sung luật \[C7\]/);
  await flush();
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[1].text, /L1 nên: Kiểm tra mapping trước khi chuyển \(Admin bổ sung, ưu tiên\)/);
  assert.equal(callbacks.length, 1);
  f.tickets.push(ticket(3, { rule: { l1Action: "LLM de nghi khac", fix: "Cach sua moi" } }));
  await f.learner.runDaily();
  const r = (await f.state()).routes[rule.category];
  assert.equal(r.l1Action, "Kiểm tra mapping trước khi chuyển");
  assert.equal(r.l1ActionByAdmin, true);
  assert.ok(r.fixes.includes("Kiểm tra mapping trước khi chuyển"));
  assert.match(f.writes[2].text, /L1 nên: Kiểm tra mapping trước khi chuyển/);
  assert.equal(await f.learner.handleReply("#duyet 123", "Admin"), null);
  assert.equal(await f.learner.handleReply("#thay 123 456", "Admin"), null);
  assert.equal(await f.learner.handleReply("#123 cach sua", "Admin"), null);
  assert.match(await f.learner.handleReply("#C7", "Admin"), /Cú pháp/);
  assert.match(await f.learner.handleReply("#sai C999", "Admin"), /Không tìm thấy/);
});

test("admin chan trong luc cho LLM, ket qua tra ve khong duoc ghi", async (t) => {
  let release, started;
  const wait = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { started = r; });
  const f = await fixture(t, [ticket(1)], undefined, { beforeAsk: async (x) => { if (x.key === "TEST-2") { started(); await wait; } } });
  await f.learner.runDaily();
  f.tickets.push(ticket(2));
  const running = f.learner.runDaily();
  await ready;
  await f.learner.handleReply("#sai C1", "Admin");
  release();
  await running;
  assert.equal(f.writes.length, 0);
  assert.equal((await f.state()).routes[rule.category].total, 2);
});

test("scrub dossier, metadata, output va ghi chu/ly do truoc khi luu", async (t) => {
  const secret = "0901234567 Tester@example.test VN150068 OUT-12345 SR-12345";
  const f = await fixture(t, [1, 2].map((n) => ticket(n, {
    group: `FIELDGO ${secret}`, assignee: `Data Team ${secret}`, dossier: `TEST-${n}: ${secret}`,
    rule: Object.fromEntries(["system", "category", "symptom", "target", "l1Action", "fix"].map((k) => [k, `${rule[k]} ${secret}`])),
  })));
  const out = await f.learner.runDaily();
  await f.learner.handleReply(`#C1 Admin chỉ: ${secret}`, `Admin ${secret}`);
  await f.learner.handleReply(`#sai C1 Sai ${secret}`, `Admin ${secret}`);
  for (const text of [JSON.stringify(f.prompts), JSON.stringify(await f.state()), JSON.stringify(f.writes), f.learner.formatRun(out), JSON.stringify(await f.learner.listRules())]) {
    assert.doesNotMatch(text, /0901234567|Tester@example\.test|VN150068|OUT-12345|SR-12345/);
  }
  assert.match(f.prompts[0].prompt, /\[SĐT\]/);
  assert.match(f.writes[0].text, /Data Team/);
  assert.match(f.writes[0].text, /\[email\]/);
  assert.match(f.writes[0].text, /\[mã\]/);
  const category = Object.keys((await f.state()).routes)[0];
  assert.ok(category.split(/\s+/).length <= 6);
});

test("migration bo pending/proposals/patterns, giu seen va ID tang dan sau restart", async (t) => {
  const initial = { learned: 7, seen: { "TEST-1": "pending", "TEST-2": "proposed", "TEST-3": "learned" },
    pending: { "TEST-1": rule }, proposals: { "TEST-2": { rule, status: "approved" } }, patterns: { "Loi cu": { count: 99 } } };
  const f = await fixture(t, [ticket(1), ticket(2), ticket(3), ticket(4)], initial);
  await f.learner.runDaily();
  const saved = await f.state();
  assert.equal(f.prompts.length, 1);
  assert.equal((await f.learner.stats()).learned, 7);
  assert.deepEqual(Object.fromEntries(Object.entries(saved.seen).filter(([k]) => k !== "TEST-4")), initial.seen);
  for (const key of ["pending", "proposals", "patterns"]) assert.equal(key in saved, false);
  assert.deepEqual(await f.learner.listRules(), []);
  assert.equal(f.writes.length, 0);
  const next = await fixture(t, [ticket(5, { rule: { category: "Lỗi đồng bộ" } })], { ...saved, nextId: 1 });
  await next.learner.runDaily();
  assert.equal((await next.state()).routes["Lỗi đồng bộ"].id, "C2");
});

test("remember loi giu tong/seen, thu lai khong doc ticket hay dem trung", async (t) => {
  const f = await fixture(t);
  f.control.failWrites = 1;
  await f.learner.runDaily();
  assert.equal((await f.state()).routes[rule.category].rememberedAt, null);
  assert.equal((await f.state()).routes[rule.category].total, 2);
  await f.learner.runDaily();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.writes.length, 1);
  assert.equal((await f.state()).routes[rule.category].rememberedTotal, 2);
  f.tickets.push(ticket(3));
  f.control.failWrites = 1;
  await f.learner.runDaily();
  assert.equal((await f.state()).routes[rule.category].rememberedTotal, 2);
  await f.learner.runDaily();
  assert.equal(f.writes.length, 2);
  assert.equal(f.prompts.length, 3);
  assert.equal((await f.state()).routes[rule.category].total, 3);
});

test("loi doc/JSON chi dem loi, khong seen de lan sau thu lai", async (t) => {
  const f = await fixture(t, [ticket(1), ticket(2, { dossierError: true }), ticket(3, { json: "khong phai JSON" })]);
  const out = await f.learner.runDaily();
  assert.equal(out.failed, 2);
  assert.deepEqual((await f.state()).seen, { "TEST-1": "counted" });
  assert.match(f.learner.formatRun(out), /Ticket đọc lỗi: 2\./);
  delete f.tickets[1].dossierError;
  delete f.tickets[2].json;
  await f.learner.runDaily();
  assert.equal((await f.state()).routes[rule.category].total, 3);
});

test("formatRun <=12 dong, toi da 6 loai moi/doi/moc, chi 1 so dem loi", async (t) => {
  const f = await fixture(t, [...Array.from({ length: 8 }, (_, n) => ticket(n + 1, { rule: { category: `Lỗi\nloại ${n + 1}`, system: "FIELDGO\nMobile", target: "Data\nTeam" } })), ticket(9, { dossierError: true })]);
  const out = await f.learner.runDaily();
  const text = f.learner.formatRun(out);
  assert.ok(text.split("\n").length <= 12);
  assert.equal((text.match(/^\[C\d+\]/gm) || []).length, 6);
  assert.match(text, /^📚 Học chuyển tuyến: đọc 9 ticket mới → 8 loại lỗi \(tổng 8\)\./);
  assert.match(text, /\[C1\] Lỗi loại 1 \(FIELDGO Mobile\) → L2 Data Team 1\/1 · MỚI/);
  assert.match(text, /Sai thì nhắn: #sai C1 · Bổ sung: #C1 <ghi chú>/);
  assert.equal((text.match(/Ticket đọc lỗi: 1\./g) || []).length, 1);
  assert.doesNotMatch(text, /#duyet|#thay|đề xuất|Hỏi:|TEST-9/);
});

const hit = { objectId: "object-test", txDigest: "tx-test", certifiedEpoch: 0, endEpoch: 10 };
const write = () => ({ job: { job_id: "test-job" }, done: Promise.resolve({ blob_id: "test-blob" }) });

test("proof xac nhan ngay thi khong len lich kiem lai", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let checks = 0;
  const proof = createProof({ chain: { owner: "test-owner", findRecentBlob: async () => { checks++; return hit; } } });
  const r = await proof.confirm(write(), { namespace: "test", author: "Admin" });
  assert.equal(r.ok, true);
  assert.equal(r.status, "confirmed");
  assert.equal(r.certifiedEpoch, 0);
  t.mock.timers.tick(360_000);
  await flush();
  assert.equal(checks, 1);
});

test("proof timeout la pending, sau 2 phut thanh cong goi onLate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let checks = 0;
  const late = [];
  const proof = createProof({ chain: { owner: "test-owner", findRecentBlob: async () => ++checks === 1 ? null : hit }, chainTimeoutMs: 10, pollMs: 10, onLate: (r) => late.push(r) });
  const pending = proof.confirm(write(), { namespace: "test", author: "Admin", chatId: "chat-a" });
  await flush();
  t.mock.timers.tick(10);
  const r = await pending;
  assert.equal(r.status, "pending");
  assert.equal(r.error, undefined);
  assert.equal(fmtProof(r), "⏳ Đang xác nhận lưu trữ, mình sẽ báo lại.");
  assert.doesNotMatch(fmtProof(r), /dạy lại/);
  t.mock.timers.tick(119_999);
  await flush();
  assert.equal(late.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(late.length, 1);
  assert.equal(late[0].status, "confirmed");
  assert.equal(late[0].chatId, "chat-a");
  assert.equal(late[0].rechecks, 1);
  assert.equal(r.status, "pending");
  t.mock.timers.tick(240_000);
  await flush();
  assert.equal(checks, 2);
});

test("proof chi kiem lai 2 lan cach 2 phut; het luot van pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const late = [], times = [];
  const proof = createProof({ chain: { owner: "test-owner", findRecentBlob: async () => { times.push(Date.now()); return null; } }, chainTimeoutMs: 10, pollMs: 10, onLate: (r) => late.push(r) });
  const pending = proof.confirm(write(), { namespace: "test" });
  await flush();
  t.mock.timers.tick(10);
  await pending;
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(120_000); await flush(); }
  assert.deepEqual(times, [0, 120_010, 240_010]);
  assert.equal(late.length, 2);
  assert.ok(late.every((r) => r.status === "pending" && !r.error));
  assert.deepEqual(late.map((r) => r.rechecks), [1, 2]);
});

test("loi doc owner/chain van pending va co callback kiem lai", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let owners = 0;
  const late = [];
  const chain = { getAccountOwner: async () => { owners++; throw new Error("chain unavailable"); } };
  const proof = createProof({ chain, chainTimeoutMs: 10, pollMs: 10, onLate: (r) => late.push(r) });
  const pending = proof.confirm(write(), { namespace: "test" });
  await flush();
  t.mock.timers.tick(10);
  const r = await pending;
  assert.equal(r.status, "pending");
  assert.equal(r.error, undefined);
  assert.equal(r.checkError, "chain unavailable");
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(owners, 2);
  assert.equal(late[0].status, "pending");
});

test("chi relayer reject/khong co blob_id moi bao failed, khong kiem lai", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  const proof = createProof({ chain: { owner: "test-owner", findRecentBlob: async () => { calls++; return hit; } }, onLate: () => calls++ });
  const missing = await proof.confirm({ job: { job_id: "missing" }, done: Promise.resolve({}) }, { namespace: "test" });
  const failed = await proof.confirm({ job: { job_id: "reject" }, done: Promise.reject(new Error("relayer failed")) }, { namespace: "test" });
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /blob_id/);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /relayer failed/);
  assert.match(fmtProof(failed), /chưa lưu được/);
  t.mock.timers.tick(360_000);
  await flush();
  assert.equal(calls, 0);
});

test("nghiep vu song song giu dung chatId va callback onLate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent = [];
  const proof = createProof({ chain: { owner: "test-owner", findRecentBlob: async () => hit }, chainTimeoutMs: 0 });
  await Promise.all(["chat-a", "chat-b"].map((chatId) => withProofContext({ chatId, onLate: (r) => sent.push({ to: r.chatId, text: fmtProof(r) }) }, async () => {
    await Promise.resolve();
    return proof.confirm(write(), { namespace: "test", author: chatId });
  })));
  t.mock.timers.tick(120_000);
  await flush();
  assert.deepEqual(sent.map((x) => x.to).sort(), ["chat-a", "chat-b"]);
  assert.ok(sent.every((x) => x.text.includes("Đã lưu chắc chắn")));
  // "Da hoc" dung ngay (addendum local); xac nhan luu bao rieng bang tin 🔒 o tren.
  assert.match(fmtTaught({ body: "Sửa mapping", userName: "Admin", when: "2026-10-24 18:00" }), /Đã học/);
});

test("index chi xu ly lenh hoc/chuyen tuyen trong DM admin, proof muon gui dung chat", async (t) => {
  // Nap rieng handler de tranh bootstrap, file state va vong getUpdates that.
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function onMessage(message)");
  const end = source.indexOf('\nconsole.log(`L1 Assistant san sang', start);
  assert.ok(start > 0 && end > start);
  const calls = [], sent = [];
  const deps = {
    cfg: { allowedDmUserIds: ["owner"], allowedChatIds: [] }, admins: ["admin"], family: new Set(),
    // Tinh nang nhac ho (26/10) chay rieng, gia lap rong o day.
    famRem: { learnContact() {}, handleTargetReply: async () => null, handleOwner: async () => null }, rememberFamily: () => {}, botName: "", chain: {}, withProofContext,
    zalo: { sendMessage: async (chatId, text) => sent.push({ chatId, text }) },
    sendProof: async (r) => { if (r?.chatId) await deps.zalo.sendMessage(r.chatId, fmtProof(r)); },
    escalation: { handleReply: async (...args) => { calls.push(args); return "Đã bổ sung"; } },
    runEscalation: async (days) => { calls.push({ days }); return "Đã học chuyển tuyến"; },
    resolveText: (text) => text, console: { log() {}, error() {} },
    assistant: { handle: async () => [], handleGeneralText: async () => [] },
  };
  const onMessage = new Function("deps", `const { ${Object.keys(deps).join(", ")} } = deps;\n${source.slice(start, end)}\nreturn onMessage;`)(deps);
  const msg = (id, text, chatId = id) => ({ chat: { id: chatId }, from: { id, display_name: "Test" }, text });
  for (const text of ["#sai C7 lý do", "#mo C7", "#C7 cách sửa", "/hoc 2"]) {
    await onMessage(msg("owner", text));
    await onMessage(msg("admin", text, "zgr-test"));
  }
  for (const text of ["#duyet 100001", "#thay 100002 100001", "#100003 cách sửa"]) await onMessage(msg("admin", text));
  assert.equal(calls.length, 0);
  await onMessage(msg("admin", "#sai C7 lý do"));
  await onMessage(msg("admin", "#mo C7"));
  await onMessage(msg("admin", "#C7 cách sửa"));
  await onMessage(msg("admin", "/hoc 2"));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(0, 3).map((x) => x[0]), ["#sai C7 lý do", "#mo C7", "#C7 cách sửa"]);
  assert.deepEqual(calls[3], { days: 2 });
  assert.ok(sent.every((x) => x.chatId === "admin"));
  sent.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const proof = createProof({ chain: { owner: "test-owner", findRecentBlob: async () => hit }, chainTimeoutMs: 0 });
  deps.assistant.handle = async () => {
    const replies = ["Đã nhận hướng dẫn"];
    replies.followUp = Promise.resolve().then(() => proof.confirm(write(), { namespace: "test", author: "Admin" })).then(fmtProof);
    return replies;
  };
  await Promise.all(["dm-a", "dm-b"].map((id) => onMessage(msg("admin", "dạy: Sửa mapping", id))));
  await flush();
  assert.equal(sent.filter((x) => x.text.includes("Đang xác nhận")).length, 2);
  t.mock.timers.tick(120_000);
  await flush();
  assert.deepEqual(sent.filter((x) => x.text.includes("Đã lưu chắc chắn")).map((x) => x.chatId).sort(), ["dm-a", "dm-b"]);
});
