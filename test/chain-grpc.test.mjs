// No network: mock BOTH HTTP/2 and fetch, exercise real SDK protobuf codecs.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { GrpcTypes } from "@mysten/sui/grpc";
import { blobIdToU256, u256ToBlobId, createChain } from "../src/chain.js";
import { createRuntime, getRuntime } from "../demo/lib/runtime.js";

const OWNER = "0xowner", ACCOUNT = "0xaccount", INNER = "0xinner", META = "0xmeta";
const SYSTEM = "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2";
const TYPE = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::blob::Blob";
const META_TYPE = "0xpackage::metadata::Metadata";
const BLOB_ID = Buffer.alloc(32, 255).toString("base64url");
const U256 = ((1n << 256n) - 1n).toString();
const flatBlob = (id) => ({
  blob_id: id === "0xa" ? U256 : id === "0xc" ? "2" : "1", size: "8192", registered_epoch: 42,
  certified_epoch: id === "0xa" ? 42 : null, storage: { end_epoch: 55 }, deletable: true,
});
const jsonBlob = (id) => {
  const f = flatBlob(id);
  return { objectId: id, content: { fields: { ...f, storage: { fields: f.storage } } } };
};
const protoObject = (objectId, json) => GrpcTypes.Object.fromJson({ objectId, json });
const expectedBlob = (id) => ({
  objectId: id, blobId: id === "0xa" ? U256 : id === "0xc" ? "2" : "1", size: 8192,
  registeredEpoch: 42, certifiedEpoch: id === "0xa" ? 42 : null, endEpoch: 55, deletable: true,
});
const meta = { memwal_job_id: "job-1", memwal_namespace: "test" };
const metadataJson = { value: { metadata: { contents: Object.entries(meta).map(([key, value]) => ({ key, value })) } } };

function grpcFixture({ service, method, input }) {
  if (service === "StateService" && method === "ListDynamicFields") {
    if (input.parent === SYSTEM) return { dynamicFields: [{ fieldId: INNER }] };
    return { dynamicFields: [{ fieldId: META, valueType: META_TYPE }] };
  }
  if (service === "LedgerService" && method === "GetObject") {
    if (["0xa", "0xb", "0xc"].includes(input.objectId)) {
      return { object: GrpcTypes.Object.create({ objectId: input.objectId, previousTransaction: "new-tx" }) };
    }
    const json = input.objectId === INNER ? { value: { committee: { epoch: 42 } } }
      : input.objectId === ACCOUNT ? { owner: OWNER } : metadataJson;
    return { object: protoObject(input.objectId, json) };
  }
  if (service === "LedgerService" && method === "GetTransaction") {
    return { transaction: { timestamp: { seconds: 12n, nanos: 345_678_901 } } };
  }
  if (service === "StateService" && method === "ListOwnedObjects") {
    assert.equal(input.objectType, TYPE);
    assert.ok(input.readMask.paths.includes("json"));
    return input.pageToken?.length
      ? { objects: [protoObject("0xb", flatBlob("0xb"))] }
      : { objects: [protoObject("0xa", flatBlob("0xa"))], nextPageToken: Uint8Array.of(1) };
  }
  if (service === "StateService" && method === "ListBalances") {
    return input.pageToken?.length
      ? { balances: [{ coinType: "0x3::wal::WAL", balance: 2500000000n }] }
      : { balances: [{ coinType: "0x2::sui::SUI", balance: 1234567890n }], nextPageToken: Uint8Array.of(2) };
  }
  throw new Error(`Unexpected gRPC method: ${service}/${method}`);
}

function jsonFixture({ method, params }) {
  if (method === "suix_getDynamicFields") return { data: [{ objectId: params[0] === SYSTEM ? INNER : META, objectType: META_TYPE }] };
  if (method === "sui_getObject") {
    const fields = params[0] === INNER ? { value: { fields: { committee: { fields: { epoch: 42 } } } } }
      : params[0] === ACCOUNT ? { owner: OWNER }
        : { value: { fields: { metadata: { fields: { contents: Object.entries(meta).map(([key, value]) => ({ fields: { key, value } })) } } } } };
    return { data: { content: { fields } } };
  }
  if (method === "suix_getOwnedObjects") {
    return params[2] ? { data: [{ data: jsonBlob("0xb") }], hasNextPage: false }
      : { data: [{ data: jsonBlob("0xa") }], hasNextPage: true, nextCursor: "0xa" };
  }
  if (method === "suix_getAllBalances") return [
    { coinType: "0x2::sui::SUI", totalBalance: "1234567890" },
    { coinType: "0x3::wal::WAL", totalBalance: "2500000000" },
  ];
  if (method === "suix_queryTransactionBlocks") return { data: [
    { digest: "new-tx", timestampMs: "12345", objectChanges: [{ objectType: TYPE, objectId: "0xa", type: "mutated" }] },
    { digest: "old-tx", timestampMs: "12000", objectChanges: [{ objectType: TYPE, objectId: "0xa", type: "created" }] },
  ] };
  if (method === "sui_multiGetObjects") return params[0].map((id) => ({ data: jsonBlob(id) }));
  throw new Error(`Unexpected JSON-RPC method: ${method}`);
}

function fixture(t, { grpc = grpcFixture, json = jsonFixture } = {}) {
  const requests = [], rpcRequests = [], sessions = [];
  t.mock.method(http2, "connect", (authority) => {
    const session = new EventEmitter();
    session.destroyed = false;
    session.destroy = () => { session.destroyed = true; };
    session.request = (headers) => {
      const stream = new EventEmitter();
      stream.end = (frame) => {
        queueMicrotask(async () => {
          try {
            assert.equal(frame[0], 0);
            assert.equal(frame.readUInt32BE(1), frame.length - 5);
            const [, service, method] = headers[":path"].match(/sui\.rpc\.v2\.(\w+)\/(\w+)$/);
            const descriptor = GrpcTypes[service].methods.find((m) => m.name === method);
            const call = { service, method, input: descriptor.I.fromBinary(frame.subarray(5)), headers, authority };
            requests.push(call);
            const reply = await grpc(call);
            if (reply.hang) return;
            const wire = reply.wire ?? {};
            stream.emit("response", { ":status": wire.http ?? 200, "content-type": wire.contentType ?? "application/grpc", ...wire.headers });
            const bytes = descriptor.O.toBinary(descriptor.O.create(wire.message ?? reply));
            const out = Buffer.alloc(bytes.length + 5);
            out.writeUInt32BE(bytes.length, 1);
            out.set(bytes, 5);
            const body = wire.body ?? out;
            // HTTP/2 chunks do not align with protobuf frame boundaries.
            stream.emit("data", body.subarray(0, 3));
            stream.emit("data", body.subarray(3));
            if (!wire.noTrailers) stream.emit("trailers", { "grpc-status": String(wire.status ?? 0), "grpc-message": wire.messageText ?? "" });
            stream.emit("end");
          } catch (error) { stream.emit("error", error); }
        });
      };
      return stream;
    };
    sessions.push(session);
    return session;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const call = { url, headers: options.headers, ...JSON.parse(options.body) };
    rpcRequests.push(call);
    const result = await json(call);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }), { status: 200 });
  });
  const chain = (transport = "auto", extra = {}) => createChain({
    apiKey: "test-key", owner: OWNER, minIntervalMs: 0, transport, ...extra,
  });
  return { chain, requests, rpcRequests, sessions };
}

test("gRPC HTTP/2 preserves existing signatures, Move JSON values, uint256 and pagination", async (t) => {
  const f = fixture(t);
  const chain = f.chain("grpc", { grpcUrl: "mock.grpc:443" });
  assert.equal(blobIdToU256(BLOB_ID), U256);
  assert.equal(await chain.getWalrusEpoch(), 42);
  assert.deepEqual(await chain.listMemoryBlobs(), [expectedBlob("0xa"), expectedBlob("0xb")]);
  assert.deepEqual(await chain.listMemoryBlobs({ max: 1 }), [expectedBlob("0xa")]);
  assert.deepEqual(await chain.getBlobMetadata("0xa"), meta);
  assert.equal(await chain.getAccountOwner(ACCOUNT), OWNER);
  assert.deepEqual(await chain.getBalances(), { SUI: 1.23456789, WAL: 2.5 });
  assert.equal(f.rpcRequests.length, 0);
  for (const request of f.requests) {
    assert.equal(request.authority, "https://mock.grpc");
    assert.equal(request.headers["x-api-key"], "test-key");
    assert.equal(request.headers["content-type"], "application/grpc");
    assert.equal(request.headers.te, "trailers");
  }
  assert.ok(f.sessions.every((session) => session.destroyed));
  assert.equal(chain.stats.grpc, f.requests.length);
  assert.equal(chain.stats.calls, chain.stats.grpc);
  assert.equal(chain.stats.jsonrpc, 0);
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(chain.stats.errors, 0);
});

test("auto propagates every unsupported gRPC read without touching EOL JSON-RPC", async (t) => {
  const f = fixture(t, { grpc: () => ({ wire: { status: 12, messageText: "not%20implemented" } }) });
  const auto = f.chain();
  for (const [method, args] of [
    ["getWalrusEpoch", []], ["listMemoryBlobs", []], ["getBlobMetadata", ["0xa"]],
    ["getAccountOwner", [ACCOUNT]], ["getBalances", []], ["findRecentBlob", [{ blobId: BLOB_ID, lookback: 7 }]],
  ]) {
    const result = auto[method](...args);
    assert.ok(result instanceof Promise);
    await assert.rejects(result, { code: "UNIMPLEMENTED", message: "not implemented" });
  }
  assert.equal(auto.stats.grpc, 6);
  assert.equal(auto.stats.errors, 6);
  assert.equal(auto.stats.fallbacks, 0);
  assert.equal(auto.stats.jsonrpc, 0);
  assert.equal(f.rpcRequests.length, 0);
});

test("a later gRPC page failure rejects the entire list without JSON-RPC or partial data", async (t) => {
  const f = fixture(t, { grpc: (call) => call.input.pageToken?.length
    ? { wire: { status: 12 } } : grpcFixture(call) });
  const chain = f.chain();
  await assert.rejects(chain.listMemoryBlobs(), { code: "UNIMPLEMENTED" });
  assert.equal(chain.stats.grpc, 2);
  assert.equal(chain.stats.jsonrpc, 0);
  assert.equal(chain.stats.fallbacks, 0);
});

test("strict grpc propagates server errors, strict jsonrpc never opens HTTP/2", async (t) => {
  const f = fixture(t, { grpc: () => ({ wire: { status: 16, messageText: "bad%20credentials" } }) });
  const grpc = f.chain("grpc");
  await assert.rejects(grpc.getBalances(), { code: "UNAUTHENTICATED", message: "bad credentials" });
  assert.equal(f.rpcRequests.length, 0);
  assert.equal(grpc.stats.fallbacks, 0);
  const count = f.requests.length;
  assert.equal(await f.chain("jsonrpc").getWalrusEpoch(), 42);
  assert.equal(f.requests.length, count);
  assert.throws(() => f.chain("invalid"), TypeError);
});

test("malformed native frames reject without JSON-RPC fallback", async (t) => {
  const f = fixture(t, { grpc: () => ({ wire: { body: Buffer.from([0, 0, 0, 0, 99]) } }) });
  const chain = f.chain();
  await assert.rejects(chain.getBalances(), { code: "DATA_LOSS" });
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(f.rpcRequests.length, 0);
  assert.ok(f.sessions.every((session) => session.destroyed));
});

test("missing gRPC trailers and missing JSON fields are observable failures", async (t) => {
  const f = fixture(t, { grpc: () => ({ wire: { noTrailers: true } }) });
  await assert.rejects(f.chain("grpc").getBalances(), { code: "DATA_LOSS" });
  // Replace the transport mock's reply for the remaining calls.
  const g = fixture(t, { grpc: (call) => call.method === "GetObject"
    ? { object: protoObject(INNER, {}) } : grpcFixture(call) });
  const chain = g.chain();
  await assert.rejects(chain.getWalrusEpoch(), /Missing Walrus epoch/);
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(g.rpcRequests.length, 0);
});

test("metadata paginates, supports dynamic object children, and returns {} when absent", async (t) => {
  const f = fixture(t, { grpc: (call) => {
    if (call.method !== "ListDynamicFields") return grpcFixture(call);
    if (call.input.parent === "0xempty") return { dynamicFields: [] };
    if (call.input.pageToken?.length) return { dynamicFields: [{ fieldId: "0xwrapper", childId: META, valueType: META_TYPE }] };
    return { dynamicFields: [{ fieldId: "0xother", valueType: "other" }], nextPageToken: Uint8Array.of(3) };
  } });
  const chain = f.chain("grpc");
  assert.deepEqual(await chain.getBlobMetadata("0xa"), meta);
  assert.equal(f.requests.find((call) => call.method === "GetObject").input.objectId, META);
  assert.deepEqual(await chain.getBlobMetadata("0xempty"), {});
});

test("explicit legacy jsonrpc preserves blobId/jobId/lookback and transaction return shapes", async (t) => {
  const f = fixture(t);
  const chain = f.chain("jsonrpc");
  const expected = { ...expectedBlob("0xa"), txDigest: "new-tx", timestampMs: 12345 };
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID, lookback: 7 }), expected);
  assert.deepEqual(await chain.findRecentBlob({ jobId: "job-1" }), { ...expectedBlob("0xa"), meta, txDigest: "new-tx", timestampMs: 12345 });
  assert.equal(await chain.findRecentBlob({ jobId: "missing" }), null);
  assert.equal(await chain.findRecentBlob({ blobId: Buffer.alloc(32).toString("base64url"), jobId: "job-1" }), null);
  const query = f.rpcRequests.find((request) => request.method === "suix_queryTransactionBlocks");
  assert.equal(query.params[2], 7);
  assert.equal(query.params[0].filter.ToAddress, OWNER);
  assert.equal(f.requests.length, 0);
  assert.ok(f.rpcRequests.every((request) => request.headers["x-api-key"] === "test-key"));
});

test("setOwner changes reads and the legacy rpc escape hatch requires explicit jsonrpc", async (t) => {
  const f = fixture(t);
  const chain = f.chain("grpc");
  assert.equal(chain.owner, OWNER);
  chain.setOwner("0xnext");
  assert.equal(chain.owner, "0xnext");
  await chain.listMemoryBlobs({ max: 1 });
  await chain.getBalances();
  assert.ok(f.requests.every((request) => request.input.owner === "0xnext"));
  await assert.rejects(chain.rpc("suix_getAllBalances", [chain.owner]), /JSON-RPC is EOL/);
  await assert.rejects(f.chain().rpc("suix_getAllBalances", [OWNER]), /JSON-RPC is EOL/);
  const json = f.chain("jsonrpc");
  const result = await json.rpc("suix_getAllBalances", [OWNER]);
  assert.ok(Array.isArray(result));
  assert.equal(chain.stats.jsonrpc, 0);
  assert.equal(json.stats.jsonrpc, 1);
});

test("explicit JSON-RPC reports HTTP 404 from the decommissioned endpoint", async (t) => {
  const f = fixture(t, { grpc: () => ({ wire: { status: 12 } }) });
  t.mock.method(globalThis, "fetch", async () => new Response("not found", { status: 404 }));
  const chain = f.chain("jsonrpc");
  await assert.rejects(chain.getBalances(), /suix_getAllBalances: HTTP 404/);
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(chain.stats.grpc, 0);
  assert.equal(chain.stats.errors, 1);
});

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a transient HTTP 429 retries gRPC without JSON-RPC", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let attempts = 0;
  const f = fixture(t, { grpc: () => ++attempts === 1 ? { wire: { http: 429 } } : {
    balances: [{ coinType: "0x2::sui::SUI", balance: 1000000000n }],
  } });
  const chain = f.chain();
  const pending = chain.getBalances();
  await flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(await pending, { SUI: 1 });
  assert.equal(chain.stats.grpc, 2);
  assert.equal(chain.stats.retries, 1);
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(f.rpcRequests.length, 0);
});

test("timed out HTTP/2 sessions close after bounded retries and auto rejects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, { grpc: () => ({ hang: true }) });
  const chain = f.chain();
  const pending = assert.rejects(chain.getBalances(), { code: "DEADLINE_EXCEEDED" });
  await flush();
  for (const ms of [20_000, 2000, 20_000, 4000, 20_000, 6000, 20_000]) {
    t.mock.timers.tick(ms);
    await flush();
  }
  await pending;
  assert.equal(chain.stats.grpc, 4);
  assert.equal(chain.stats.retries, 3);
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(chain.stats.jsonrpc, 0);
  assert.ok(f.sessions.every((session) => session.destroyed));
});

test("HTTP/2 connection errors propagate without automatic JSON-RPC", async (t) => {
  const f = fixture(t, { grpc: () => { throw new Error("connect ECONNREFUSED"); } });
  const chain = f.chain();
  await assert.rejects(chain.getAccountOwner(ACCOUNT), /connect ECONNREFUSED/);
  assert.equal(chain.stats.fallbacks, 0);
  assert.equal(chain.stats.errors, 1);
  assert.equal(chain.stats.jsonrpc, 0);
});

test("blob ID conversion round-trips all 32 little-endian bytes without losing zero padding", () => {
  const ids = [Buffer.alloc(32), Buffer.alloc(32, 255), Buffer.from(Array.from({ length: 32 }, (_, i) => i))];
  for (const bytes of ids) {
    const blobId = bytes.toString("base64url");
    assert.equal(u256ToBlobId(blobIdToU256(blobId)), blobId);
    assert.equal(Buffer.from(u256ToBlobId(blobIdToU256(blobId)), "base64url").length, 32);
  }
  for (const value of ["0", "1", "256", (1n << 255n).toString(), U256]) {
    assert.equal(blobIdToU256(u256ToBlobId(value)), value);
  }
  assert.equal(u256ToBlobId(U256), BLOB_ID);
  assert.throws(() => u256ToBlobId(-1n), RangeError);
  assert.throws(() => u256ToBlobId(1n << 256n), RangeError);
});

const hit = (id) => ({ ...expectedBlob(id), txDigest: "new-tx", timestampMs: 12345 });
const pages = (f) => f.requests.filter((call) => call.method === "ListOwnedObjects");

test("default findRecentBlob scans all pages, caches hits/misses, and gets the previous transaction", async (t) => {
  const f = fixture(t);
  const chain = f.chain();
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID, lookback: 1 }), hit("0xa"));
  assert.equal(pages(f).length, 2); // A first-page hit must still finish the scan.
  const count = f.requests.length;
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(await chain.findRecentBlob({ blobId: u256ToBlobId(0) }), null);
  assert.equal(await chain.findRecentBlob({ blobId: u256ToBlobId(0), jobId: "job-1" }), null);
  assert.equal(await chain.findRecentBlob({ jobId: "job-1" }), null);
  assert.equal(await chain.findRecentBlob({}), null);
  assert.equal(f.requests.length, count);
  assert.equal(chain.stats.blobScans, 1);
  assert.equal(chain.stats.blobCacheHits, 4);
  assert.equal(f.rpcRequests.length, 0);
  const object = f.requests.find((call) => call.method === "GetObject");
  assert.deepEqual(object.input.readMask.paths, ["object_id", "previous_transaction"]);
  const tx = f.requests.find((call) => call.method === "GetTransaction");
  assert.equal(tx.input.digest, "new-tx");
  assert.deepEqual(tx.input.readMask.paths, ["timestamp"]);
});

test("concurrent blobId/jobId requests share a single complete scan and transaction reads", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { grpc: async (call) => {
    if (call.method === "ListOwnedObjects" && call.input.pageToken?.length) await gate;
    return grpcFixture(call);
  } });
  const chain = f.chain("grpc");
  const pending = Promise.all([
    chain.findRecentBlob({ blobId: BLOB_ID }), chain.findRecentBlob({ blobId: u256ToBlobId(1) }),
    chain.findRecentBlob({ blobId: BLOB_ID }), chain.findRecentBlob({ blobId: u256ToBlobId(0) }),
    chain.findRecentBlob({ jobId: "job-1" }),
  ]);
  await flush();
  assert.equal(pages(f).length, 2);
  assert.equal(chain.stats.blobScans, 1);
  assert.equal(chain.stats.blobScanWaits, 4);
  assert.equal(f.requests.filter((call) => call.method === "GetObject").length, 0);
  release();
  assert.deepEqual(await pending, [hit("0xa"), hit("0xb"), hit("0xa"), null, null]);
  assert.equal(pages(f).length, 2);
  assert.equal(f.requests.filter((call) => call.method === "GetObject").length, 2);
  assert.equal(f.requests.filter((call) => call.method === "GetTransaction").length, 2);
  assert.equal(f.rpcRequests.length, 0);
});

test("snapshot TTL starts after the complete 33s scan and expires at 60s", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture(t, { grpc: (call) => {
    if (call.method === "ListOwnedObjects") t.mock.timers.tick(16_500);
    return grpcFixture(call);
  } });
  const chain = f.chain();
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(chain.stats.blobScanMs, 33_000);
  t.mock.timers.tick(59_999);
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(pages(f).length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(pages(f).length, 4);
  assert.equal(chain.stats.blobScans, 2);
  assert.equal(chain.stats.blobScanMs, 66_000);
});

test("jobId reads metadata only for object IDs added since the previous complete scan", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let added = false;
  const f = fixture(t, { grpc: (call) => {
    if (call.method === "ListOwnedObjects" && call.input.pageToken?.length && added) {
      return { objects: [protoObject("0xb", flatBlob("0xb")), protoObject("0xc", flatBlob("0xc"))] };
    }
    return grpcFixture(call);
  } });
  const chain = f.chain();
  assert.equal(await chain.findRecentBlob({ jobId: "job-1" }), null);
  assert.equal(f.requests.some((call) => call.method === "ListDynamicFields"), false);
  added = true;
  t.mock.timers.tick(60_000);
  const results = await Promise.all([
    chain.findRecentBlob({ jobId: "missing", lookback: 1 }),
    chain.findRecentBlob({ jobId: "job-1", lookback: 1 }),
  ]);
  assert.deepEqual(results, [null, { ...hit("0xc"), meta }]);
  assert.deepEqual(f.requests.filter((call) => call.method === "ListDynamicFields").map((call) => call.input.parent), ["0xc"]);
  assert.deepEqual(await chain.findRecentBlob({ blobId: u256ToBlobId(2) }), hit("0xc"));
  assert.equal(pages(f).length, 4);
  t.mock.timers.tick(60_000);
  assert.equal(await chain.findRecentBlob({ jobId: "job-1" }), null);
  assert.equal(f.requests.filter((call) => call.method === "ListDynamicFields").length, 1);
  assert.equal(chain.stats.blobScans, 3);
  assert.equal(f.rpcRequests.length, 0);
});

test("a failed refresh shares its rejection, keeps the previous baseline, and allows a fresh scan", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let phase = "baseline";
  const f = fixture(t, { grpc: (call) => {
    if (call.method === "ListOwnedObjects" && call.input.pageToken?.length) {
      if (phase === "fail") return { wire: { status: 12 } };
      if (phase === "new") return { objects: [protoObject("0xb", flatBlob("0xb")), protoObject("0xc", flatBlob("0xc"))] };
    }
    return grpcFixture(call);
  } });
  const chain = f.chain();
  assert.equal(await chain.findRecentBlob({ jobId: "job-1" }), null);
  t.mock.timers.tick(60_000);
  phase = "fail";
  const results = await Promise.allSettled([
    chain.findRecentBlob({ blobId: BLOB_ID }), chain.findRecentBlob({ jobId: "job-1" }),
  ]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.code === "UNIMPLEMENTED"));
  assert.equal(results[0].reason, results[1].reason);
  phase = "new";
  assert.deepEqual(await chain.findRecentBlob({ jobId: "job-1" }), { ...hit("0xc"), meta });
  assert.equal(pages(f).length, 6);
  assert.equal(chain.stats.blobScans, 3);
  assert.equal(f.rpcRequests.length, 0);
});

test("a negative cached lookup sees a newly owned blob when proof checks again after two minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let added = false;
  const f = fixture(t, { grpc: (call) => call.method === "ListOwnedObjects" && added && call.input.pageToken?.length
    ? { objects: [protoObject("0xc", flatBlob("0xc"))] } : grpcFixture(call) });
  const chain = f.chain();
  assert.equal(await chain.findRecentBlob({ blobId: u256ToBlobId(2) }), null);
  added = true;
  assert.equal(await chain.findRecentBlob({ blobId: u256ToBlobId(2) }), null);
  t.mock.timers.tick(120_000);
  assert.deepEqual(await chain.findRecentBlob({ blobId: u256ToBlobId(2) }), hit("0xc"));
  assert.equal(chain.stats.blobScans, 2);
});

test("partial public lists do not seed the full findRecentBlob snapshot", async (t) => {
  const f = fixture(t);
  const chain = f.chain();
  assert.deepEqual(await chain.listMemoryBlobs({ max: 1 }), [expectedBlob("0xa")]);
  assert.deepEqual(await chain.findRecentBlob({ blobId: u256ToBlobId(1), lookback: 1 }), hit("0xb"));
  assert.equal(pages(f).length, 3);
});

test("optional timestamps may be unavailable without losing the Blob or retrying", async (t) => {
  const f = fixture(t, { grpc: (call) => call.method === "GetTransaction"
    ? { wire: { status: 14 } } : grpcFixture(call) });
  const chain = f.chain();
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), { ...expectedBlob("0xa"), txDigest: "new-tx" });
  assert.equal(chain.stats.retries, 0);
  assert.equal(f.requests.filter((call) => call.method === "GetTransaction").length, 1);
  assert.equal(f.rpcRequests.length, 0);
});

test("missing optional previous_transaction or timestamp is omitted from results", async (t) => {
  const f = fixture(t, { grpc: (call) => {
    if (call.method === "GetObject" && call.input.objectId === "0xb") {
      return { object: GrpcTypes.Object.create({ objectId: "0xb" }) };
    }
    return call.method === "GetTransaction" ? { transaction: {} } : grpcFixture(call);
  } });
  const chain = f.chain();
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), { ...expectedBlob("0xa"), txDigest: "new-tx" });
  assert.deepEqual(await chain.findRecentBlob({ blobId: u256ToBlobId(1) }), expectedBlob("0xb"));
  assert.equal(f.requests.filter((call) => call.method === "GetTransaction").length, 1);
});

test("failed GetObject reads can retry against the same scan snapshot", async (t) => {
  let fail = true;
  const f = fixture(t, { grpc: (call) => call.method === "GetObject" && fail
    ? { wire: { status: 12 } } : grpcFixture(call) });
  const chain = f.chain();
  await assert.rejects(chain.findRecentBlob({ blobId: BLOB_ID }), { code: "UNIMPLEMENTED" });
  fail = false;
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(chain.stats.blobScans, 1);
});

test("owner changes isolate caches and pagination already in flight keeps its original owner", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { grpc: async (call) => {
    if (call.method === "ListOwnedObjects" && call.input.owner === OWNER && !call.input.pageToken?.length) await gate;
    return grpcFixture(call);
  } });
  const chain = f.chain();
  const old = chain.findRecentBlob({ blobId: BLOB_ID });
  await flush();
  chain.setOwner("0xnext");
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  release();
  assert.deepEqual(await old, hit("0xa"));
  assert.deepEqual(pages(f).map((call) => call.input.owner), [OWNER, "0xnext", "0xnext", OWNER]);
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  chain.setOwner("0xnext");
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(pages(f).length, 4);
  assert.equal(chain.stats.blobScans, 2);
  // Separate chain clients must not reuse a snapshot authenticated for another client.
  assert.deepEqual(await f.chain("grpc", { owner: "0xnext" }).findRecentBlob({ blobId: BLOB_ID }), hit("0xa"));
  assert.equal(pages(f).length, 6);
});

test("a warm demo runtime shares initialization and blob scans across concurrent proof readers", async (t) => {
  const f = fixture(t);
  const runtime = createRuntime({ TATUM_API_KEY: "synthetic", MEMWAL_ACCOUNT_ID: ACCOUNT });
  const [a, b] = await Promise.all([runtime.getChain(), runtime.getChain()]);
  assert.equal(a, b); assert.equal(a.owner, OWNER);
  assert.equal(f.requests.length, 1);
  assert.equal(getRuntime(), getRuntime());
  await Promise.all([a.findRecentBlob({ blobId: BLOB_ID }), b.findRecentBlob({ blobId: BLOB_ID })]);
  assert.equal(pages(f).length, 2);
  assert.equal(a.stats.blobScans, 1);
  assert.equal(a.stats.blobScanWaits, 1);
});

test("failed owner initialization is never published and the next request retries it", async (t) => {
  let fail = true;
  const f = fixture(t, { grpc: call => fail ? { wire: { http: 429 } } : grpcFixture(call) });
  const runtime = createRuntime({ TATUM_API_KEY: "synthetic", MEMWAL_ACCOUNT_ID: ACCOUNT });
  await assert.rejects(runtime.getChain(), { httpStatus: 429, operation: "LedgerService/GetObject" });
  fail = false;
  const chain = await runtime.getChain();
  assert.equal(chain.owner, OWNER); assert.equal(f.requests.length, 2);
});

test("aborting a proof scan closes HTTP/2, clears pending state and permits a fresh scan", async (t) => {
  let hang = true;
  const f = fixture(t, { grpc: call => hang ? { hang: true } : grpcFixture(call) });
  const chain = f.chain("grpc", { maxRetries: 0 });
  const controller = new AbortController();
  const pending = assert.rejects(chain.findRecentBlob({ blobId: BLOB_ID, signal: controller.signal }), { name: "AbortError" });
  await flush();
  assert.equal(f.requests.length, 1);
  controller.abort();
  await pending;
  assert.equal(f.sessions[0].destroyed, true);
  hang = false;
  assert.deepEqual(await chain.findRecentBlob({ blobId: BLOB_ID, signal: new AbortController().signal }), hit("0xa"));
  assert.equal(chain.stats.blobScans, 2);
});

test("an aborted throttled read never opens another HTTP/2 connection", async (t) => {
  const f = fixture(t);
  const chain = f.chain("grpc", { minIntervalMs: 60000, maxRetries: 0 });
  assert.equal(await chain.getAccountOwner(ACCOUNT), OWNER);
  const controller = new AbortController();
  const pending = assert.rejects(chain.getAccountOwner(ACCOUNT, { signal: controller.signal }), { name: "AbortError" });
  controller.abort();
  await pending;
  assert.equal(f.requests.length, 1);
});
