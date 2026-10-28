// Doc chain Sui qua Tatum gRPC (CHI DOC, khong ky giao dich).
// Tatum JSON-RPC da EOL (HTTP 404, kiem tra 24/10/2026); chi dung khi ep jsonrpc.
// Moi memory cua MemWal = 1 object Blob tren Sui, owner = vi cua Tester, co:
//   - storage.end_epoch: het epoch nay la blob mat vinh vien
//   - dynamic field "metadata": memwal_job_id, memwal_namespace, ...
// User L1 khong thay gi o day; chi admin/log/bao cao dung.
import http2 from "node:http2";
import { AsyncLocalStorage } from "node:async_hooks";
import { GrpcTypes, GrpcStatusCode, RpcError } from "@mysten/sui/grpc";

const WALRUS_PKG = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77";
const BLOB_TYPE = `${WALRUS_PKG}::blob::Blob`;
const WALRUS_SYSTEM = "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2";
const BLOB_SCAN_TTL_MS = 60_000;

// Walrus tra blob_id dang base64url (32 byte), tren chain luu dang so u256 (little-endian).
export function blobIdToU256(blobId) {
  const bytes = Buffer.from(String(blobId).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n.toString();
}

export function u256ToBlobId(value) {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new RangeError("Blob ID must fit in u256");
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(n & 255n);
    n >>= 8n;
  }
  return bytes.toString("base64url");
}

function parseBlob(obj) {
  const f = obj?.content?.fields;
  if (!f) return null;
  return {
    objectId: obj.objectId,
    blobId: f.blob_id,
    size: Number(f.size),
    registeredEpoch: f.registered_epoch,
    certifiedEpoch: f.certified_epoch, // null = chua certify (chua luu xong)
    endEpoch: f.storage?.fields?.end_epoch,
    deletable: f.deletable,
  };
}

function metadataToMap(fieldObj) {
  const entries = fieldObj?.content?.fields?.value?.fields?.metadata?.fields?.contents || [];
  return Object.fromEntries(entries.map((e) => [e.fields.key, e.fields.value]));
}

// Tatum tra application/grpc, KHONG phai grpc-web: GrpcWebFetchTransport bao
// "unexpected response content type: application/grpc" (da kiem tra live).
// Dung HTTP/2 cua Node va protobuf PUBLIC cua SDK da cai, khong them dependency.
// Chi ho tro unary read; khong giu session nen khong can them ham close() vao API.
async function grpcUnary(url, apiKey, service, methodName, input, signal) {
  signal?.throwIfAborted();
  const serviceType = GrpcTypes[service];
  const method = serviceType?.methods.find((m) => m.name === methodName);
  if (!method) throw new RpcError(`${service}/${methodName} is unsupported`, "UNIMPLEMENTED");
  const bytes = method.I.toBinary(method.I.create(input));
  const frame = Buffer.alloc(5 + bytes.length);
  frame.writeUInt32BE(bytes.length, 1);
  frame.set(bytes, 5);

  return new Promise((resolve, reject) => {
    let session, request, headers = {}, trailers = {}, size = 0, settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      session?.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new RpcError(`${service}/${methodName}: timeout after 20000ms`, "DEADLINE_EXCEEDED")), 20_000);
    const onAbort = () => finish(signal.reason || new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      session = http2.connect(url.origin);
      session.on("error", (error) => finish(error));
      request = session.request({
        ":method": "POST",
        ":path": `${url.pathname.replace(/\/$/, "")}/${serviceType.typeName}/${method.name}`,
        "content-type": "application/grpc",
        "grpc-accept-encoding": "identity",
        "grpc-timeout": "20000m",
        te: "trailers",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      });
      request.on("error", (error) => finish(error));
      request.on("aborted", () => finish(new RpcError("gRPC stream aborted", "UNAVAILABLE")));
      request.on("response", (value) => { headers = value; });
      request.on("trailers", (value) => { trailers = value; });
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) finish(new RpcError("gRPC response exceeds 16 MiB", "RESOURCE_EXHAUSTED"));
        else chunks.push(chunk);
      });
      request.on("end", () => {
        if (settled) return;
        try {
          if (headers[":status"] !== 200) {
            throw Object.assign(new Error(`gRPC HTTP ${headers[":status"]}`), { httpStatus: headers[":status"], retry: headers[":status"] === 429 || headers[":status"] >= 500 });
          }
          const code = trailers["grpc-status"] ?? headers["grpc-status"];
          if (code == null) throw new RpcError("Missing gRPC status trailers", "DATA_LOSS");
          if (String(code) !== "0") {
            let message = String(trailers["grpc-message"] ?? headers["grpc-message"] ?? `gRPC status ${code}`);
            try { message = decodeURIComponent(message); } catch { /* Keep malformed server text. */ }
            throw new RpcError(message, GrpcStatusCode[Number(code)] ?? "UNKNOWN");
          }
          if (!String(headers["content-type"]).startsWith("application/grpc")) throw new Error("Unexpected gRPC content type");
          const body = Buffer.concat(chunks);
          // Unary = exactly one uncompressed length-prefixed protobuf message.
          if (body.length < 5 || body[0] !== 0 || body.readUInt32BE(1) !== body.length - 5) {
            throw new RpcError("Invalid or compressed gRPC unary frame", "DATA_LOSS");
          }
          finish(null, method.O.fromBinary(body.subarray(5)));
        } catch (error) { finish(error); }
      });
      request.end(frame);
    } catch (error) { finish(error); }
  });
}

// gRPC json la Move JSON phang, khong co cac wrapper { type, fields } cua JSON-RPC.
function grpcBlob(object) {
  const f = GrpcTypes.Object.toJson(object).json;
  if (!f || f.blob_id == null || f.storage?.end_epoch == null) throw new Error("Missing gRPC Blob JSON fields");
  return {
    objectId: object.objectId,
    blobId: String(f.blob_id),
    size: Number(f.size),
    registeredEpoch: Number(f.registered_epoch),
    certifiedEpoch: f.certified_epoch == null ? null : Number(f.certified_epoch),
    endEpoch: Number(f.storage.end_epoch),
    deletable: f.deletable,
  };
}

export function createChain({
  rpcUrl = "https://sui-mainnet.gateway.tatum.io",
  grpcUrl = "https://sui-mainnet-grpc.gateway.tatum.io:443",
  transport = "auto",
  apiKey = "", owner = "", minIntervalMs, maxRetries = 3,
} = {}) {
  if (!["auto", "grpc", "jsonrpc"].includes(transport)) throw new TypeError(`Invalid chain transport: ${transport}`);
  const grpcEndpoint = new URL(/^https?:\/\//.test(grpcUrl) ? grpcUrl : `https://${grpcUrl}`);
  // Khong co key: Tatum cho 5 req/phut. Co key: free plan nhanh hon nhieu.
  const gap = minIntervalMs ?? (apiKey ? 400 : 12_500);
  let nextAt = 0;
  const readContext = new AsyncLocalStorage();
  // A request deadline cancels its HTTP/2 reads, including a shared in-flight scan.
  // Other waiters can poll again; no scan has to finish after the response is sent.
  const scoped = (fn) => (...args) => {
    const signal = args.find(arg => arg?.signal)?.signal;
    return signal ? readContext.run(signal, () => fn(...args)) : fn(...args);
  };
  let blobCache = { snapshot: null, pending: null };
  const stats = {
    calls: 0, errors: 0, retries: 0, totalMs: 0, grpc: 0, jsonrpc: 0, fallbacks: 0,
    blobScans: 0, blobScanMs: 0, blobCacheHits: 0, blobScanWaits: 0,
  };

  async function throttle() {
    const signal = readContext.getStore();
    signal?.throwIfAborted();
    const at = Math.max(nextAt, Date.now());
    nextAt = at + gap;
    const wait = at - Date.now();
    if (wait > 0) await new Promise((resolve, reject) => {
      const finish = (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      const abort = () => finish(signal.reason || new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(), wait);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
  }

  // auto = gRPC. Khong fallback sang endpoint JSON-RPC da EOL.
  async function read(grpcRead, jsonRead) {
    if (transport === "jsonrpc") return jsonRead();
    return grpcRead();
  }

  async function grpc(service, method, input, { attempt = 0, retries = maxRetries } = {}) {
    await throttle();
    const started = Date.now();
    stats.calls++;
    stats.grpc++;
    try { return await grpcUnary(grpcEndpoint, apiKey, service, method, input, readContext.getStore()); }
    catch (error) {
      error.operation = `${service}/${method}`;
      if ((error.retry || ["RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(error.code)) && attempt < retries) {
        stats.retries++;
        await new Promise((r) => setTimeout(r, (attempt + 1) * Math.max(gap, 2000)));
        return grpc(service, method, input, { attempt: attempt + 1, retries });
      }
      stats.errors++;
      throw error;
    }
    finally { stats.totalMs += Date.now() - started; }
  }

  async function grpcObject(objectId) {
    const { object } = await grpc("LedgerService", "GetObject", {
      objectId, readMask: { paths: ["object_id", "json"] },
    });
    if (!object?.json) throw new Error("Missing gRPC object JSON");
    return GrpcTypes.Object.toJson(object).json;
  }

  async function rpc(method, params, attempt = 0) {
    // Legacy escape hatch cung can transport:"jsonrpc" ro rang.
    if (transport !== "jsonrpc") throw new Error('JSON-RPC is EOL; set transport:"jsonrpc" explicitly');
    await throttle();
    const started = Date.now();
    stats.calls++;
    stats.jsonrpc++;
    const headers = { "content-type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    let body;
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: stats.calls, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      body = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    } catch (err) {
      if ((err.retry || err.name === "TimeoutError") && attempt < 3) {
        stats.retries++;
        await new Promise((r) => setTimeout(r, (attempt + 1) * Math.max(gap, 2000)));
        return rpc(method, params, attempt + 1);
      }
      stats.errors++;
      throw err;
    } finally {
      stats.totalMs += Date.now() - started;
    }
    if (body.error) {
      stats.errors++;
      throw new Error(`${method}: ${body.error.message}`);
    }
    return body.result;
  }

  async function getObjects(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = await rpc("sui_multiGetObjects", [ids.slice(i, i + 50), { showContent: true }]);
      out.push(...chunk.map((r) => r.data).filter(Boolean));
    }
    return out;
  }

  // Epoch Walrus hien Tester (doc tu object System -> inner state).
  async function jsonWalrusEpoch() {
    const fields = await rpc("suix_getDynamicFields", [WALRUS_SYSTEM, null, 1]);
    const innerId = fields.data[0]?.objectId;
    const inner = await rpc("sui_getObject", [innerId, { showContent: true }]);
    const v = inner.data.content.fields.value.fields;
    return Number(v.committee?.fields?.epoch ?? v.epoch);
  }

  async function getWalrusEpoch() {
    return read(async () => {
      const fields = await grpc("StateService", "ListDynamicFields", {
        parent: WALRUS_SYSTEM, pageSize: 1, readMask: { paths: ["field_id", "child_id"] },
      });
      const field = fields.dynamicFields[0];
      const innerId = field?.childId ?? field?.fieldId;
      if (!innerId) throw new Error("Missing Walrus inner state");
      const inner = await grpcObject(innerId);
      const v = inner.value ?? inner;
      const epoch = Number(v.committee?.epoch ?? v.epoch);
      if (!Number.isFinite(epoch)) throw new Error("Missing Walrus epoch in gRPC JSON");
      return epoch;
    }, jsonWalrusEpoch);
  }

  // Tat ca blob memory cua vi (phan trang 50/lan).
  async function jsonMemoryBlobs({ max = Infinity } = {}) {
    const blobs = [];
    let cursor = null;
    do {
      const page = await rpc("suix_getOwnedObjects", [
        owner,
        { filter: { StructType: BLOB_TYPE }, options: { showContent: true } },
        cursor,
        50,
      ]);
      for (const o of page.data) {
        const b = parseBlob(o.data);
        if (b) blobs.push(b);
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor && blobs.length < max);
    return blobs;
  }

  async function listMemoryBlobs({ max = Infinity } = {}) {
    const listOwner = owner;
    return read(async () => {
      const blobs = [];
      let pageToken;
      do {
        const page = await grpc("StateService", "ListOwnedObjects", {
          owner: listOwner, objectType: BLOB_TYPE, pageSize: 50, pageToken,
          readMask: { paths: ["object_id", "json"] },
        });
        blobs.push(...page.objects.map(grpcBlob));
        pageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      } while (pageToken && blobs.length < max);
      return blobs;
    }, () => jsonMemoryBlobs({ max }));
  }

  async function jsonBlobMetadata(objectId) {
    const fields = await rpc("suix_getDynamicFields", [objectId, null, 5]);
    const meta = fields.data.find((d) => d.objectType?.endsWith("::metadata::Metadata"));
    if (!meta) return {};
    const obj = await rpc("sui_getObject", [meta.objectId, { showContent: true }]);
    return metadataToMap(obj.data);
  }

  async function getBlobMetadata(objectId) {
    return read(async () => {
      let pageToken;
      do {
        const page = await grpc("StateService", "ListDynamicFields", {
          parent: objectId, pageSize: 5, pageToken,
          readMask: { paths: ["field_id", "child_id", "value_type"] },
        });
        const meta = page.dynamicFields.find((d) => d.valueType?.endsWith("::metadata::Metadata"));
        if (meta) {
          const obj = await grpcObject(meta.childId ?? meta.fieldId);
          const entries = obj.value?.metadata?.contents;
          if (!Array.isArray(entries)) throw new Error("Missing gRPC metadata JSON fields");
          return Object.fromEntries(entries.map((e) => [e.key, e.value]));
        }
        pageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      } while (pageToken);
      return {};
    }, () => jsonBlobMetadata(objectId));
  }

  // Legacy JSON-RPC da EOL. Tim blob vua tao: xem giao dich gan nhat gui object toi vi,
  // lay cac Blob duoc tao, so blob_id. Tra ve null neu chua thay.
  async function jsonRecentBlob({ blobId, jobId, lookback = 20 }) {
    const want = blobId ? blobIdToU256(blobId) : null;
    const txs = await rpc("suix_queryTransactionBlocks", [
      { filter: { ToAddress: owner }, options: { showObjectChanges: true } },
      null,
      lookback,
      true,
    ]);
    // 1 memory di qua nhieu giao dich (tao blob, certify, gan metadata) -> lay ca
    // blob "created" lan "mutated", giu giao dich moi nhat cho moi blob.
    const created = [];
    for (const tx of txs.data) {
      for (const ch of tx.objectChanges || []) {
        if (ch.objectType === BLOB_TYPE && !created.some((c) => c.id === ch.objectId)) {
          created.push({ id: ch.objectId, digest: tx.digest, timestampMs: tx.timestampMs });
        }
      }
    }
    if (!created.length) return null;
    const objs = await getObjects(created.map((c) => c.id));
    for (const o of objs) {
      const b = parseBlob(o);
      if (!b) continue;
      const tx = created.find((c) => c.id === b.objectId);
      if (want && b.blobId === want) return { ...b, txDigest: tx.digest, timestampMs: Number(tx.timestampMs) };
      if (jobId && !want) {
        const meta = await jsonBlobMetadata(b.objectId);
        if (meta.memwal_job_id === jobId) return { ...b, meta, txDigest: tx.digest, timestampMs: Number(tx.timestampMs) };
      }
    }
    return null;
  }

  // Object moi co the o BAT KY trang nao: luon quet het, khong dung lookback.
  // Moi findRecentBlob tren chain/owner nay dung chung snapshot va pending promise.
  // TTL tinh tu luc quet XONG; miss van tra null de proof.js kiem lai sau 2 phut.
  async function ownedBlobSnapshot() {
    const cache = blobCache;
    if (cache.pending) {
      stats.blobScanWaits++;
      return cache.pending;
    }
    if (cache.snapshot && Date.now() - cache.snapshot.completedAt < BLOB_SCAN_TTL_MS) {
      stats.blobCacheHits++;
      return cache.snapshot;
    }
    const started = Date.now();
    stats.blobScans++;
    cache.pending = (async () => {
      try {
        const blobs = await listMemoryBlobs();
        const previous = cache.snapshot;
        const byBlobId = new Map();
        for (const blob of blobs) {
          if (!byBlobId.has(blob.blobId)) byBlobId.set(blob.blobId, blob);
        }
        const snapshot = {
          byBlobId,
          objectIds: new Set(blobs.map((blob) => blob.objectId)),
          newBlobs: previous ? blobs.filter((blob) => !previous.objectIds.has(blob.objectId)) : null,
          metadata: new Map(), transactions: new Map(), completedAt: Date.now(),
        };
        cache.snapshot = snapshot;
        return snapshot;
      } finally {
        stats.blobScanMs += Date.now() - started;
        cache.pending = null;
      }
    })();
    return cache.pending;
  }

  function cachedRead(cache, key, load) {
    if (!cache.has(key)) {
      cache.set(key, load().catch((error) => {
        cache.delete(key);
        throw error;
      }));
    }
    return cache.get(key);
  }

  async function blobTransaction(snapshot, blob) {
    return cachedRead(snapshot.transactions, blob.objectId, async () => {
      const { object } = await grpc("LedgerService", "GetObject", {
        objectId: blob.objectId, readMask: { paths: ["object_id", "previous_transaction"] },
      });
      if (!object) throw new Error("Missing gRPC Blob object");
      const result = { ...blob };
      if (object.previousTransaction) {
        result.txDigest = object.previousTransaction;
        // Timestamp la tuy chon: chi 1 unary read nho, khong retry neu khong lay duoc.
        try {
          const { transaction } = await grpc("LedgerService", "GetTransaction", {
            digest: result.txDigest, readMask: { paths: ["timestamp"] },
          }, { retries: 0 });
          if (transaction?.timestamp) {
            const { seconds, nanos } = transaction.timestamp;
            result.timestampMs = Number(seconds) * 1000 + Math.floor(nanos / 1_000_000);
          }
        } catch { /* Blob va txDigest da duoc xac nhan; timestamp khong bat buoc. */ }
      }
      return result;
    });
  }

  async function findRecentBlob({ blobId, jobId, lookback = 20 }) {
    return read(async () => {
      if (!blobId && !jobId) return null;
      const snapshot = await ownedBlobSnapshot();
      if (blobId) {
        const blob = snapshot.byBlobId.get(blobIdToU256(blobId));
        return blob ? { ...await blobTransaction(snapshot, blob) } : null;
      }
      // Chua co lan quet truoc de diff objectId: khong the suy ra blob moi cho jobId.
      if (!snapshot.newBlobs) return null;
      for (const blob of snapshot.newBlobs) {
        const meta = await cachedRead(snapshot.metadata, blob.objectId, () => getBlobMetadata(blob.objectId));
        if (meta.memwal_job_id === jobId) return { ...await blobTransaction(snapshot, blob), meta: { ...meta } };
      }
      return null;
    }, () => jsonRecentBlob({ blobId, jobId, lookback }));
  }

  // Owner cua MemWalAccount (shared object) = vi giu cac blob memory.
  async function getAccountOwner(accountId) {
    return read(async () => (await grpcObject(accountId)).owner, async () => {
      const obj = await rpc("sui_getObject", [accountId, { showContent: true }]);
      return obj.data?.content?.fields?.owner;
    });
  }

  async function getBalances() {
    return read(async () => {
      const balances = [];
      let pageToken;
      do {
        const page = await grpc("StateService", "ListBalances", { owner, pageSize: 50, pageToken });
        balances.push(...page.balances);
        pageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
      } while (pageToken);
      // Giu don vi /1e9 va ten coin nhu API cu, ke ca coin co decimals khac 9.
      return Object.fromEntries(balances.map((b) => [b.coinType.split("::").pop(), Number(b.balance) / 1e9]));
    }, async () => {
      const all = await rpc("suix_getAllBalances", [owner]);
      return Object.fromEntries(all.map((b) => [b.coinType.split("::").pop(), Number(b.totalBalance) / 1e9]));
    });
  }

  return {
    rpc,
    getWalrusEpoch: scoped(getWalrusEpoch),
    listMemoryBlobs: scoped(listMemoryBlobs),
    getBlobMetadata,
    findRecentBlob: scoped(findRecentBlob),
    getAccountOwner: scoped(getAccountOwner),
    getBalances,
    stats,
    get owner() {
      return owner;
    },
    setOwner(addr) {
      if (owner !== addr) blobCache = { snapshot: null, pending: null };
      owner = addr;
    },
  };
}
