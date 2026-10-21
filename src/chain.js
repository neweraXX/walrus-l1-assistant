// Doc chain Sui qua Tatum RPC de kiem chung memory cua bot (CHI DOC, khong ky giao dich).
// Moi memory cua MemWal = 1 object Blob tren Sui, owner = vi cua minh, co:
//   - storage.end_epoch: het epoch nay la blob mat vinh vien
//   - dynamic field "metadata": memwal_job_id, memwal_namespace, ...
// User L1 khong thay gi o day; chi admin/log/bao cao dung.

const WALRUS_PKG = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77";
const BLOB_TYPE = `${WALRUS_PKG}::blob::Blob`;
const WALRUS_SYSTEM = "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2";

// Walrus tra blob_id dang base64url (32 byte), tren chain luu dang so u256 (little-endian).
export function blobIdToU256(blobId) {
  const bytes = Buffer.from(String(blobId).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n.toString();
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

export function createChain({ rpcUrl = "https://sui-mainnet.gateway.tatum.io", apiKey = "", owner = "", minIntervalMs } = {}) {
  // Khong co key: Tatum cho 5 req/phut. Co key: free plan nhanh hon nhieu.
  const gap = minIntervalMs ?? (apiKey ? 400 : 12_500);
  let last = 0;
  const stats = { calls: 0, errors: 0, retries: 0, totalMs: 0 };

  async function rpc(method, params, attempt = 0) {
    const wait = last + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const started = Date.now();
    stats.calls++;
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

  // Epoch Walrus hien tai (doc tu object System -> inner state).
  async function getWalrusEpoch() {
    const fields = await rpc("suix_getDynamicFields", [WALRUS_SYSTEM, null, 1]);
    const innerId = fields.data[0]?.objectId;
    const inner = await rpc("sui_getObject", [innerId, { showContent: true }]);
    const v = inner.data.content.fields.value.fields;
    return Number(v.committee?.fields?.epoch ?? v.epoch);
  }

  // Tat ca blob memory cua vi (phan trang 50/lan).
  async function listMemoryBlobs({ max = Infinity } = {}) {
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

  async function getBlobMetadata(objectId) {
    const fields = await rpc("suix_getDynamicFields", [objectId, null, 5]);
    const meta = fields.data.find((d) => d.objectType?.endsWith("::metadata::Metadata"));
    if (!meta) return {};
    const obj = await rpc("sui_getObject", [meta.objectId, { showContent: true }]);
    return metadataToMap(obj.data);
  }

  // Tim blob vua tao cho 1 lan remember: xem cac giao dich gan nhat gui object toi vi,
  // lay cac Blob duoc tao, so blob_id. Tra ve null neu chua thay.
  async function findRecentBlob({ blobId, jobId, lookback = 20 }) {
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
        const meta = await getBlobMetadata(b.objectId);
        if (meta.memwal_job_id === jobId) return { ...b, meta, txDigest: tx.digest, timestampMs: Number(tx.timestampMs) };
      }
    }
    return null;
  }

  // Owner cua MemWalAccount (shared object) = vi giu cac blob memory.
  async function getAccountOwner(accountId) {
    const obj = await rpc("sui_getObject", [accountId, { showContent: true }]);
    return obj.data?.content?.fields?.owner;
  }

  async function getBalances() {
    const all = await rpc("suix_getAllBalances", [owner]);
    return Object.fromEntries(all.map((b) => [b.coinType.split("::").pop(), Number(b.totalBalance) / 1e9]));
  }

  return {
    rpc,
    getWalrusEpoch,
    listMemoryBlobs,
    getBlobMetadata,
    findRecentBlob,
    getAccountOwner,
    getBalances,
    stats,
    get owner() {
      return owner;
    },
    setOwner(addr) {
      owner = addr;
    },
  };
}
