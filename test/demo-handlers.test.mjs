import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "./helpers.mjs";
import { seedDemo } from "../demo/seed.mjs";
import { createRuntime } from "../demo/lib/runtime.js";
import { createServer } from "../demo/dev-server.mjs";
import { createHandler, sign, verify } from "../demo/lib/handler.js";
import { createLimiter } from "../demo/lib/limits.js";
import { bundleText, ruleFromEvidence, parseKnowledge, ruleKey, evidenceOf, SEED_NS } from "../demo/lib/rules.js";
import { parseRouteHint } from "../src/escalation.js";

beforeEach((t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network is forbidden in tests"); });
  t.mock.method(http2, "connect", () => { throw new Error("HTTP/2 network is forbidden in tests"); });
  t.mock.method(console, "error", () => {});
});
const secret = "synthetic-test-cookie-secret";
const evidence = (key, route = "L2", target = "Data Team") => ({ key, system: "FieldGo", summary: "Missing route for order", description: "Order reference has no route association.",
  route, target: route === "L1" ? "" : target, resolution: "The route association was repaired.", category: "Missing order delivery route", l1Action: "Send the missing order route association to the Data Team." });
const known = [evidence("TRAIN-1"), evidence("TRAIN-2")];
const makeHit = (rows = known, id = "C1", at = "2026-10-24T00:00:00Z") => ({ text: bundleText(rows, ruleFromEvidence(rows, id), at), distance: 0.1, blob_id: "blob-synthetic", created_at: at });
const answer = (route = "L2", target = "Data Team") => ({ route, target: route === "L1" ? "" : target, confidence: 0.8, reason: "The missing route requires a privileged data correction." });
const holdout = Array.from({ length: 10 }, (_, i) => ({ summary: `New FieldGo order ${i} has no delivery association`, description: "The order reference has no route.", label: i < 6 ? "L2" : "L1", target: i < 6 ? "Data Team" : "" }));

function fixture({ seed = [makeHit()], ask, read, status, chain: overrides = {}, persist = true } = {}) {
  let time = 1_000_000, sequence = 0;
  const store = new Map([[SEED_NS, seed]]), accepted = new Map(), recalls = [], calls = [], finds = [], writes = [];
  const limiter = createLimiter({ now: () => time });
  const chain = { getWalrusEpoch: async () => 42, listMemoryBlobs: async () => [{ objectId: "0xf00", endEpoch: 50, certifiedEpoch: 40 }],
    findRecentBlob: async (params) => { finds.push(params); return { objectId: "0xf00", txDigest: "syntheticTx", certifiedEpoch: 40, endEpoch: 50 }; }, ...overrides };
  const deps = { secret, tickets: async () => known, holdout: async () => holdout,
    memory: {
      recall: async (namespace, query, options) => { recalls.push({ namespace, query, options }); return read ? read(namespace, query, options) : (store.get(namespace) || []).toReversed(); },
      remember: async (namespace, text) => {
        const job_id = `job-${++sequence}`, hit = { text, distance: 0.1, blob_id: `blob-${sequence}`, created_at: new Date(Date.now() + sequence).toISOString() };
        writes.push({ namespace, text }); accepted.set(job_id, { namespace, status: "done", blob_id: hit.blob_id });
        if (persist) store.set(namespace, [...(store.get(namespace) || []), hit]);
        return { job_id, status: "pending" };
      },
      status: async (id) => status ? status(id) : accepted.get(id) || { status: "pending" },
    },
    ask: async (args) => { calls.push(args); return ask ? ask(args, calls.length) : JSON.stringify(answer()); },
    getChain: async () => chain,
  };
  function client(ip = "192.0.2.1") { return { ip, jar: {}, header: "" }; }
  async function invoke(name, body, visitor = client(), options = {}) {
    const req = { method: options.method || (["rules", "proof", "health", "tickets"].includes(name) ? "GET" : "POST"), url: `/api/${name}${options.query || ""}`, body,
      headers: { "x-forwarded-for": visitor.ip, "x-forwarded-proto": "https", ...(options.cookie !== false ? { cookie: Object.entries(visitor.jar).map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...(options.header !== false && visitor.header ? { "x-demo-budget": visitor.header } : {}) } };
    const headers = {}; let raw;
    const res = { statusCode: 200, setHeader: (key, value) => { headers[key.toLowerCase()] = value; }, end: (body) => { raw = body; } };
    // New handler and dependencies for every invocation; only the mock Walrus store is persistent.
    await createHandler(name, () => ({ ...deps }), options.cold ? createLimiter({ now: () => time }) : limiter)(req, res);
    for (const cookie of headers["set-cookie"] || []) { const [k, v] = cookie.split(";")[0].split("="); visitor.jar[k] = v; }
    visitor.header = headers["x-demo-budget"] || visitor.header;
    return { status: res.statusCode, data: JSON.parse(raw), headers };
  }
  return { deps, store, accepted, recalls, calls, finds, writes, client, invoke, advance: (ms = 61000) => { time += ms; } };
}

test("all serverless endpoints export default handlers and Vercel uses the root function entry", async () => {
  for (const name of ["rules", "tickets", "health", "proof", "ask", "learn", "block", "measure"]) {
    assert.equal(typeof (await import(`../demo/api/${name}.js`)).default, "function");
  }
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.functions["api/*.js"].maxDuration, 60);
  const root = (await import("../api/[name].js")).default;
  let result;
  await root({ url: "/api/unknown" }, { setHeader() {}, end(s) { result = s; } });
  assert.match(result, /Not found/);
});

test("rules are recalled/parsed from seed and session, expose policy and signed stateless proof jobs", async () => {
  const f = fixture(), visitor = f.client();
  const response = await f.invoke("rules", undefined, visitor);
  assert.equal(response.status, 200);
  assert.equal(response.data.rules.length, 1);
  const rule = response.data.rules[0];
  assert.equal(rule.category, known[0].category); assert.equal(rule.total, 2); assert.equal(rule.confidence, 1);
  assert.deepEqual(rule.examples, ["TRAIN-1", "TRAIN-2"]);
  assert.equal(rule.proof, null); assert.equal(rule.blocked, false); assert.equal(rule.text, undefined);
  assert.equal(response.data.policy.minConfidence, 0.6); assert.equal(response.data.policy.minTickets, 2);
  const token = verify(rule.jobId, secret); assert.equal(token.blobId, "blob-synthetic"); assert.equal(token.namespace, SEED_NS);
  assert.deepEqual(f.recalls.map((r) => r.namespace), [SEED_NS, `demo:s:${verify(visitor.jar.demo_session, secret).id}`]);
  assert.ok(response.headers["set-cookie"].every((s) => /HttpOnly; SameSite=Lax.*Secure/.test(s)));
  assert.equal(response.headers["cache-control"], "no-store");
  const fresh = await f.invoke("rules", undefined, visitor, { cold: true });
  assert.equal(fresh.data.rules[0].category, rule.category);
});

test("English and legacy rule parsing enforce actual ratio and consistent application systems", () => {
  assert.equal(parseRouteHint(makeHit().text).route, "L2");
  assert.equal(parseRouteHint(makeHit().text.replace("2/2 tickets, 100%", "596/1000 tickets, 60%")), null);
  assert.equal(parseRouteHint(makeHit().text.replace("2/2 tickets, 100%", "1/1 tickets, 100%")), null);
  const invalid = { ...makeHit(), text: makeHit().text.replace("2/2 tickets, 100%", "1/2 tickets, 50%") };
  assert.deepEqual(parseKnowledge([invalid]), []);
});

test("memory OFF makes one model call and never recalls memory", async () => {
  const f = fixture({ read: () => assert.fail("OFF cannot recall") });
  const response = await f.invoke("ask", { question: "FieldGo has a missing route.", memory: false });
  assert.equal(response.status, 200); assert.equal(f.calls.length, 1); assert.equal(f.recalls.length, 0);
  assert.deepEqual(response.data.rulesUsed, []); assert.equal(response.data.hint, "");
  assert.deepEqual(response.data.route, "L2"); assert.equal(response.data.target, "Data Team");
  assert.ok(!f.calls[0].prompt.includes("learnedRules"));
});

test("memory ON filters recalled rules, emits an English plain-text hint, and hides proof from L1", async () => {
  const f = fixture();
  const response = await f.invoke("ask", { question: "FieldGo has a missing delivery route.", memory: true });
  assert.equal(response.status, 200); assert.equal(response.data.rulesUsed.length, 1);
  assert.match(response.data.hint, /Similar past issues.*L2 Data Team/);
  assert.doesNotMatch(response.data.hint, /\*\*|blockchain|Tatum|epoch|blob/);
  assert.match(f.calls[0].prompt, /Routing rule \[C1\]/); assert.ok(!f.calls[0].prompt.includes("Demo evidence"));
  assert.ok(!JSON.stringify(response.data).includes("blob-synthetic"));
  const g = fixture();
  const other = await g.invoke("ask", { question: "CoolerTrack has a pairing problem.", memory: true });
  assert.deepEqual(other.data.rulesUsed, []);
  const distant = fixture({ seed: [{ ...makeHit(), distance: 0.9 }] });
  assert.deepEqual((await distant.invoke("ask", { question: "FieldGo is broken.", memory: true })).data.rulesUsed, []);
});

test("learning persists one job immediately; a second same-category ticket becomes trusted without approval", async () => {
  const f = fixture({ seed: [], ask: () => JSON.stringify({ category: known[0].category, l1Action: known[0].l1Action }) }), visitor = f.client();
  let response = await f.invoke("learn", { ticket: evidence("VISIT-1") }, visitor);
  assert.equal(response.status, 202); assert.equal(response.data.learned, false); assert.equal(response.data.total, 1);
  assert.ok(response.data.jobId); assert.equal(f.finds.length, 0); assert.equal(f.writes.length, 1);
  assert.equal((await f.invoke("rules", undefined, visitor, { cold: true })).data.rules.length, 0);
  response = await f.invoke("learn", { ticket: evidence("VISIT-2") }, visitor, { cold: true });
  assert.equal(response.status, 202); assert.equal(response.data.learned, true); assert.equal(response.data.total, 2);
  assert.match(f.writes[1].text, /Routing rule \[C\d+\]/); assert.doesNotMatch(f.writes[1].text, /Luật chuyển tuyến/);
  const rules = await f.invoke("rules", undefined, visitor, { cold: true });
  assert.equal(rules.data.rules.length, 1); assert.equal(rules.data.rules[0].total, 2);
  const duplicate = await f.invoke("learn", { ticket: evidence("VISIT-2") }, visitor);
  assert.equal(duplicate.status, 409); assert.equal(f.writes.length, 2);
});

test("newer insufficient-agreement snapshots suppress an old trusted rule", () => {
  const conflicting = [...known, evidence("TRAIN-3", "L1"), evidence("TRAIN-4", "L1")];
  const newer = makeHit(conflicting, "C1", "2026-10-25T00:00:00Z");
  assert.equal(ruleFromEvidence(conflicting), null);
  assert.deepEqual(parseKnowledge([makeHit(), newer]), []);
  // Even equal write timestamps cannot revive the older, smaller snapshot.
  assert.deepEqual(parseKnowledge([makeHit(), { ...newer, created_at: makeHit().created_at }]), []);
  const enough = [...conflicting, evidence("TRAIN-5")];
  assert.equal(ruleFromEvidence(enough).confidence, 0.6);
});

test("admin veto and reopen persist across handlers and stay isolated to one session", async () => {
  const f = fixture(), a = f.client(), b = f.client("192.0.2.2");
  await f.invoke("rules", undefined, a); await f.invoke("rules", undefined, b);
  const key = ruleKey(known[0]);
  const blocked = await f.invoke("block", { key, action: "block" }, a);
  assert.equal(blocked.status, 202); assert.ok(blocked.data.jobId); assert.match(f.writes[0].text, /#sai/);
  const view = await f.invoke("rules", undefined, a, { cold: true }); assert.equal(view.data.rules[0].blocked, true);
  assert.equal((await f.invoke("rules", undefined, b, { cold: true })).data.rules[0].blocked, false);
  const answerA = await f.invoke("ask", { question: "FieldGo has no route.", memory: true }, a);
  assert.deepEqual(answerA.data.rulesUsed, []);
  await f.invoke("block", { key, action: "open" }, a, { cold: true });
  assert.match(f.writes[1].text, /#mo/);
  assert.equal((await f.invoke("rules", undefined, a, { cold: true })).data.rules[0].blocked, false);
});

test("proof polls call findRecentBlob on every cold invocation, returning pending then confirmed", async () => {
  let polls = 0;
  const f = fixture({ status: () => ({ status: "running" }), chain: { findRecentBlob: async (query) => { f.finds.push(query); return ++polls === 1 ? null : { certifiedEpoch: 0, objectId: "0xbeef", txDigest: "tx", endEpoch: 8 }; } },
    ask: () => JSON.stringify({ category: known[0].category, l1Action: known[0].l1Action }) }), visitor = f.client();
  const learned = await f.invoke("learn", { ticket: evidence("VISIT-3") }, visitor);
  const query = `?job=${encodeURIComponent(learned.data.jobId)}`;
  const pending = await f.invoke("proof", undefined, visitor, { query, cold: true });
  assert.equal(pending.status, 200); assert.equal(pending.data.status, "pending"); assert.equal(pending.data.proof, null);
  assert.equal(f.finds[0].jobId, "job-1");
  const confirmed = await f.invoke("proof", undefined, visitor, { query, cold: true });
  assert.equal(confirmed.data.status, "confirmed"); assert.equal(confirmed.data.proof.objectId, "0xbeef"); assert.equal(confirmed.data.proof.endEpoch, 8);
  assert.equal(f.finds.length, 2); assert.equal(confirmed.data.transport, "Tatum Sui gRPC");
  const other = await f.invoke("proof", undefined, f.client("192.0.2.2"), { query, cold: true }); assert.equal(other.status, 404);
  assert.equal(f.finds.length, 2);
});

test("rules provide seed blob proof tokens that work without any job registry", async () => {
  const f = fixture(), visitor = f.client();
  const rules = await f.invoke("rules", undefined, visitor);
  const response = await f.invoke("proof", undefined, visitor, { query: `?job=${encodeURIComponent(rules.data.rules[0].jobId)}`, cold: true });
  assert.equal(response.data.status, "confirmed");
  assert.deepEqual(f.finds.map(({ signal, ...query }) => query), [{ jobId: undefined, blobId: "blob-synthetic" }]);
  assert.equal(f.finds[0].signal.aborted, false);
  assert.equal(response.data.currentEpoch, 42);
  assert.equal(response.data.objectId, response.data.proof.objectId);
});

test("raw blob proofs are restricted to recalled seed/session rules", async () => {
  const blobId = Buffer.alloc(32, 1).toString("base64url"), otherId = Buffer.alloc(32, 2).toString("base64url");
  const f = fixture({ seed: [{ ...makeHit(), blob_id: blobId }] }), visitor = f.client();
  const response = await f.invoke("proof", undefined, visitor, { query: `?blobId=${blobId}` });
  assert.equal(response.status, 200); assert.equal(response.data.status, "confirmed");
  assert.equal(response.data.currentEpoch, 42); assert.equal(f.finds[0].blobId, blobId);
  assert.equal((await f.invoke("proof", undefined, visitor, { query: `?blobId=${otherId}` })).status, 404);
  assert.equal((await f.invoke("proof", undefined, visitor, { query: "?blobId=invalid" })).status, 404);
  assert.equal((await f.invoke("proof", undefined, visitor, { query: `?job=forged&blobId=${blobId}` })).status, 404);
  assert.equal(f.finds.length, 1);
});

test("proof returns pending on rate limits and transient gRPC failures, logs the actual operation safely", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  for (const metadata of [{ httpStatus: 429 }, { code: "RESOURCE_EXHAUSTED" }, { code: "UNAVAILABLE" }, { code: "DEADLINE_EXCEEDED" }]) {
    const f = fixture({ chain: { findRecentBlob: async () => { throw Object.assign(new Error('provider-secret=do-not-print {"payload":"private"}'), { operation: "StateService/ListOwnedObjects", ...metadata }); } } }), visitor = f.client();
    const rules = await f.invoke("rules", undefined, visitor);
    const response = await f.invoke("proof", undefined, visitor, { query: `?job=${rules.data.rules[0].jobId}` });
    assert.equal(response.status, 200); assert.deepEqual(response.data, { status: "pending", proof: null });
    assert.equal(response.headers["retry-after"], "5");
  }
  assert.equal(logs.length, 4);
  assert.ok(logs.every(([, log]) => log.handler === "proof" && log.stage === "chain.findRecentBlob" && log.operation === "StateService/ListOwnedObjects"));
  assert.doesNotMatch(JSON.stringify(logs), /provider-secret|do-not-print|payload|private/);
});

test("proof deadline returns pending at 45 seconds and aborts the active chain read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  let signal;
  const f = fixture({ chain: { findRecentBlob: async (query) => { signal = query.signal; return new Promise(() => {}); } } }), visitor = f.client();
  const rules = await f.invoke("rules", undefined, visitor);
  const pending = f.invoke("proof", undefined, visitor, { query: `?job=${rules.data.rules[0].jobId}` });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(45000);
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.data.status, "pending");
  assert.equal(signal.aborted, true);
});

test("every handler logs structured failures without upstream messages, payloads or credentials", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const sensitive = Object.assign(new Error('Demo key=abc {"payload":"secret"} https://upstream.invalid?api_key=abc'), { status: 503, code: "PRIVATE_KEY_ABC" });
  for (const name of ["rules", "tickets", "health", "proof", "ask", "learn", "block", "measure"]) {
    const handler = createHandler(name, () => { throw sensitive; });
    let body;
    await handler({ method: ["rules", "tickets", "health", "proof"].includes(name) ? "GET" : "POST" }, { setHeader() {}, end(value) { body = value; } });
    assert.doesNotMatch(body, /key=abc|payload|secret|api_key/);
  }
  assert.deepEqual(logs.map(([, log]) => log.handler), ["rules", "tickets", "health", "proof", "ask", "learn", "block", "measure"]);
  assert.doesNotMatch(JSON.stringify(logs), /key=abc|payload|secret|api_key|PRIVATE_KEY_ABC/);
});

test("health returns epoch, blob count, approximate safe date and the gRPC transport", async () => {
  const f = fixture(), response = await f.invoke("health");
  assert.equal(response.status, 200); assert.equal(response.data.epoch, 42); assert.equal(response.data.blobCount, 1);
  assert.match(response.data.safeUntil, /^\d{4}-\d{2}-\d{2}$/); assert.equal(response.data.transport, "Tatum Sui gRPC"); assert.equal(response.data.approximate, true);
  const empty = fixture({ chain: { listMemoryBlobs: async () => [] } });
  assert.equal((await empty.invoke("health")).data.safeUntil, null);
});

test("measure performs exactly two 10-ticket batch calls, scores routes, and never sends labels to the model", async () => {
  const f = fixture({ ask: (args, n) => JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ index, ...answer(n === 1 || index < 6 ? "L2" : "L1") })).reverse()) });
  const response = await f.invoke("measure", {});
  assert.equal(response.status, 200); assert.equal(response.data.llmCalls, 2); assert.equal(f.calls.length, 2);
  assert.deepEqual(response.data.off, { correct: 6, total: 10, accuracy: 0.6 });
  assert.deepEqual(response.data.on, { correct: 10, total: 10, accuracy: 1 }); assert.equal(response.data.details.length, 10);
  assert.equal(response.data.details[7].onCorrect, true); assert.equal(response.data.details[7].offCorrect, false);
  assert.ok(response.data.elapsedMs < 60000);
  const [off, on] = f.calls.map((a) => JSON.parse(a.prompt));
  assert.equal(off.tickets.length, 10); assert.equal(off.learnedRulesByTicket, undefined);
  assert.equal(on.learnedRulesByTicket.length, 10); assert.ok(on.learnedRulesByTicket.every((c) => c.rules[0].startsWith("Routing rule")));
  for (const prompt of f.calls) { assert.doesNotMatch(prompt.prompt, /"(?:label|expected|expectedTarget)":/); assert.match(prompt.system, /JSON ARRAY/); }
});

test("measure rejects partial, duplicate or invalid batch predictions without fabricating scores", async () => {
  for (const output of ["{}", "not-json", JSON.stringify([{ index: 0, ...answer() }]), JSON.stringify(Array.from({ length: 10 }, () => ({ index: 0, ...answer() }))), JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ index, ...answer(), confidence: 2 })))]) {
    const f = fixture({ ask: () => output }), result = await f.invoke("measure", {});
    assert.equal(result.status, 502); assert.equal(result.data.off, undefined);
    assert.equal(f.calls.length, 3);
  }
});

test("measure normalizes numeric strings and complete positional arrays without retry", async () => {
  const variations = [
    rows => rows.map((r, i) => ({ ...r, index: String(i) })).reverse(),
    rows => rows.map(({ index, ...r }) => r),
    rows => rows.map((r, i) => i % 2 ? r : (({ index, ...value }) => value)(r)),
  ];
  for (const variation of variations) {
    const f = fixture({ ask: () => JSON.stringify(variation(holdout.map((t, index) => ({ index, ...answer(t.label) })))) });
    const response = await f.invoke("measure", {});
    assert.equal(response.status, 200);
    assert.equal(response.data.llmCalls, 2);
    assert.equal(response.data.on.accuracy, 1);
    assert.equal(response.data.off.accuracy, 1);
  }
});

test("one retry repairs either or both failed modes within the three-call budget", async () => {
  for (const failed of [[1], [2], [1, 2]]) {
    const f = fixture({ ask: (args, n) => {
      if (n > 3) return JSON.stringify(answer());
      const rows = holdout.map((t, index) => ({ index, ...answer(t.label) }));
      if (n < 3) return JSON.stringify(failed.includes(n) ? rows.map(r => ({ ...r, index: 1 })) : rows);
      const data = JSON.parse(args.prompt);
      assert.deepEqual(data.batches.map(b => b.mode), failed.map(n => n === 1 ? "off" : "on"));
      assert.match(args.system, /Never omit, duplicate or change any index/);
      for (const batch of data.batches) assert.equal(Boolean(batch.learnedRulesByTicket), batch.mode === "on");
      return JSON.stringify(Object.fromEntries(data.batches.map(b => [b.mode, rows])));
    } }), visitor = f.client();
    const response = await f.invoke("measure", {}, visitor);
    assert.equal(response.status, 200);
    assert.equal(response.data.llmCalls, 3);
    assert.equal(response.data.on.accuracy, 1);
    assert.equal(response.data.off.accuracy, 1);
    assert.equal(verify(visitor.jar.demo_budget, secret).calls.length, 3);
    assert.ok(f.calls.every(call => call.timeoutMs === 14000));
    for (const call of f.calls) assert.doesNotMatch(call.prompt, /"(?:label|expected|expectedTarget)":/);
    assert.equal((await f.invoke("ask", { question: "Test", memory: false }, visitor, { cold: true })).status, 200);
    assert.equal((await f.invoke("ask", { question: "Test", memory: false }, visitor, { cold: true })).status, 429);
  }
});

test("mixed unordered missing indexes, duplicate normalized indexes and invalid values require repair", async () => {
  const rows = holdout.map((t, index) => ({ index, ...answer(t.label) }));
  const invalid = [
    rows.map((r, i) => i === 0 ? { ...r, index: undefined } : { ...r, index: 9 - i }),
    rows.map((r, i) => ({ ...r, index: i === 1 ? "0" : r.index })),
    ...[null, -1, 10, "", "1.5", "NaN", true].map(index => rows.map((r, i) => i === 0 ? { ...r, index } : r)),
  ];
  for (const raw of invalid) {
    const f = fixture({ ask: (_, n) => JSON.stringify(n < 3 ? raw : { off: rows, on: rows }) });
    const response = await f.invoke("measure", {});
    assert.equal(response.status, 200);
    assert.equal(response.data.llmCalls, 3);
  }
});

test("measure cooldown survives cold instances via cookie or header and is bound to IP", async () => {
  const f = fixture({ ask: () => JSON.stringify(Array.from({ length: 10 }, (_, index) => ({ index, ...answer() }))) }), visitor = f.client();
  assert.equal((await f.invoke("measure", {}, visitor)).status, 200);
  const again = await f.invoke("measure", {}, visitor, { cold: true });
  assert.equal(again.status, 429); assert.equal(again.headers["retry-after"], "60"); assert.equal(f.calls.length, 2);
  assert.equal((await f.invoke("measure", {}, visitor, { cold: true, cookie: false })).status, 429);
  const differentIp = { ...visitor, ip: "192.0.2.9", jar: { ...visitor.jar } };
  assert.equal((await f.invoke("measure", {}, differentIp, { cold: true })).status, 200);
  f.advance(); assert.equal((await f.invoke("measure", {}, visitor, { cold: true })).status, 200);
});

test("shared queue admits at most four LLM calls per minute, serializes them, and limits IP requests", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) assert.equal((await f.invoke("ask", { question: "A new question", memory: false }, f.client(`192.0.2.${i + 1}`))).status, 200);
  assert.equal((await f.invoke("ask", { question: "A new question", memory: false }, f.client("192.0.2.99"))).status, 429);
  assert.equal(f.calls.length, 4); f.advance();
  assert.equal((await f.invoke("ask", { question: "A new question", memory: false })).status, 200);
  const gate = createLimiter({ now: () => 1000000 }); let running = 0, max = 0;
  await Promise.all([1, 2, 3].map(() => gate.enqueue(async () => { running++; max = Math.max(max, running); await Promise.resolve(); running--; })));
  assert.equal(max, 1);
  const rate = fixture(); for (let i = 0; i < 120; i++) assert.equal((await rate.invoke("tickets")).status, 200);
  assert.equal((await rate.invoke("tickets")).status, 429);
});

test("methods, bodies, job signatures and service failures have safe response shapes", async () => {
  const f = fixture();
  const wrongMethod = await f.invoke("ask", undefined, f.client(), { method: "GET" });
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.allow, "POST");
  for (const body of [{}, { question: "", memory: true }, { question: "hello", memory: "true" }, [], "{bad", { question: "x".repeat(13000), memory: true }]) {
    const response = await fixture().invoke("ask", body); assert.ok([400, 413].includes(response.status));
  }
  assert.equal((await f.invoke("learn", { ticket: { summary: "Not a closed ticket" } })).status, 400);
  assert.equal((await f.invoke("proof", undefined, f.client(), { query: "?job=forged" })).status, 404);
  const denied = fixture({ read: () => { throw new Error("provider-secret=never-return-this"); } });
  const response = await denied.invoke("rules"); assert.equal(response.status, 502); assert.doesNotMatch(JSON.stringify(response), /provider-secret/);
  assert.equal(verify(sign({ id: "ok" }, secret) + "x", secret), null);
});

test("request deadline stops a stuck batch before Vercel's 60 second budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const f = fixture({ ask: () => new Promise(() => {}) });
  const pending = f.invoke("measure", {});
  for (let i = 0; i < 30; i++) await Promise.resolve();
  t.mock.timers.tick(52000);
  const response = await pending; assert.equal(response.status, 504);
  assert.match(response.data.error, /timed out/);
});

test("8s recall and three 14s prediction calls complete a repaired measure below 55s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const rows = holdout.map((ticket, index) => ({ index, ...answer(ticket.label) }));
  const f = fixture({
    read: async () => { await new Promise(resolve => setTimeout(resolve, 8000)); return [makeHit()]; },
    ask: async (_, n) => {
      await new Promise(resolve => setTimeout(resolve, 14000));
      return JSON.stringify(n === 1 ? rows.map(row => ({ ...row, index: 0 })) : n === 2 ? rows : { off: rows });
    },
  });
  const pending = f.invoke("measure", {});
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  await flush();
  for (const ms of [8000, 14000, 14000, 14000]) { t.mock.timers.tick(ms); await flush(); }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.data.llmCalls, 3);
  assert.equal(response.data.elapsedMs, 50000);
  assert.equal(response.data.on.accuracy, 1);
});

test("public training and holdout fixtures are disjoint, synthetic, and have expected sizes", async () => {
  const training = JSON.parse(await readFile(new URL("../demo/data/tickets.json", import.meta.url), "utf8"));
  const fresh = JSON.parse(await readFile(new URL("../demo/data/holdout.json", import.meta.url), "utf8"));
  assert.equal(training.length, 24); assert.equal(fresh.length, 10);
  assert.equal(new Set(training.map((r) => r.key)).size, 24);
  const seen = new Set(training.map((r) => r.summary + r.description));
  for (const t of fresh) { assert.ok(!seen.has(t.summary + t.description)); assert.ok(["L1", "L2", "VENDOR"].includes(t.label)); }
});

test("seed learner writes six English rules with all 24 training examples and checks proof using mocks", async (t) => {
  t.mock.method(console, "log", () => {});
  const dir = await mkdtemp(path.join(tmpdir(), "demo-seed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writes = [], finds = [];
  const runtime = { memory: {
    remember: async (namespace, text) => { writes.push({ namespace, text }); return { job_id: `seed-${writes.length}` }; },
    status: async (job) => ({ status: "done", blob_id: `blob-${job}`, namespace: SEED_NS }),
  }, getChain: async () => ({ findRecentBlob: async (query) => { finds.push(query); return { objectId: "0xf00", txDigest: "tx", endEpoch: 50, certifiedEpoch: 42 }; } }) };
  const statePath = path.join(dir, "seed.json");
  const first = await seedDemo({ runtime, statePath });
  assert.equal(first.result.checked, 24); assert.equal(first.result.failed, 0); assert.equal(first.rules.length, 6);
  assert.equal(writes.length, 6); assert.equal(finds.length, 6); assert.ok(first.proofs.every((r) => r.status === "confirmed"));
  assert.ok(writes.every((r) => r.namespace === SEED_NS && r.text.includes("Routing rule [C") && !r.text.includes("Luật chuyển tuyến")));
  assert.equal(evidenceOf(writes).length, 24);
  const rules = parseKnowledge(writes); assert.equal(rules.length, 6); assert.ok(rules.every((r) => r.total === 4 && r.confidence === 1));
  assert.ok(rules.some((r) => r.system === "DistributorHub" && r.route === "VENDOR" && r.target === "Northwind Systems"));
  assert.equal((await seedDemo({ runtime, statePath })).result.checked, 0); assert.equal(writes.length, 6);
});

test("signed IP budgets cap four calls even on cold handlers in the same millisecond", async () => {
  const f = fixture(), visitor = f.client();
  for (let i = 0; i < 4; i++) assert.equal((await f.invoke("ask", { question: "A fresh support issue", memory: false }, visitor, { cold: true })).status, 200);
  assert.equal((await f.invoke("ask", { question: "A fifth issue", memory: false }, visitor, { cold: true })).status, 429);
  assert.equal(f.calls.length, 4);
});

test("runtime fails safely without configured credentials before opening network connections", async () => {
  const runtime = createRuntime({});
  assert.equal((await runtime.tickets()).length, 24);
  await assert.rejects(runtime.memory.recall(SEED_NS, "rules", {}), { status: 503 });
  await assert.rejects(runtime.ask({ system: "test", prompt: "test" }), { status: 503 });
  await assert.rejects(runtime.getChain(), { status: 503 });
});

test("development server serves the English page and denies repository paths without opening a socket", async () => {
  const server = createServer(), handle = server.listeners("request")[0];
  const get = async (url) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(code) { this.statusCode = code; }, end(body) { this.body = String(body); } };
    await handle({ method: "GET", url }, res); return res;
  };
  const page = await get("/"); assert.match(page.body, /<html lang="en">/); assert.match(page.body, /Measure OFF vs ON/);
  assert.equal(page.headers["Content-Type"], "text/html; charset=utf-8");
  for (const url of ["/.env", "/src/config.js", "/data/holdout.json", "/api/unknown"]) assert.equal((await get(url)).statusCode, 404);
  assert.equal(server.listening, false);
});

test("seed write rejection cannot be reported as successful seeding", async (t) => {
  t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {});
  const dir = await mkdtemp(path.join(tmpdir(), "demo-seed-failed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = { memory: { remember: async () => { throw new Error("mock relayer rejected write"); } } };
  await assert.rejects(seedDemo({ runtime, statePath: path.join(dir, "seed.json") }), /rule writes failed/);
});
