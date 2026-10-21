// "Da nho that chua?" — sau khi relayer bao xong 1 lan remember, tim blob tren chain (Tatum)
// va xac nhan da certify. Ghi moi lan vao logs/proof.jsonl (so cai: ai day, luc nao, blob nao,
// het han epoch nao) de bao cao / truy nguon / canh bao het han ve sau.
import { appendFile } from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createProof({ chain, logPath, accountId, pollMs = 5000, chainTimeoutMs = 90_000 }) {
  async function ensureOwner() {
    if (!chain.owner) chain.setOwner(await chain.getAccountOwner(accountId));
  }

  // write = { job, done } tu memory.remember(). Tra ve { ok, ... } — khong bao gio throw.
  async function confirm(write, { namespace, author }) {
    const t0 = Date.now();
    const jobId = write.job?.job_id;
    const record = { ts: new Date().toISOString(), namespace, author, jobId };
    try {
      const r = await write.done; // relayer: embedding + SEAL + upload Walrus
      record.relayerMs = Date.now() - t0;
      record.blobId = r?.blob_id;
      if (!record.blobId) throw new Error("relayer khong tra blob_id");
      await ensureOwner();
      for (let tries = 1; Date.now() - t0 < chainTimeoutMs + record.relayerMs; tries++) {
        const hit = await chain.findRecentBlob({ blobId: record.blobId, lookback: 10 }).catch(() => null);
        if (hit?.certifiedEpoch != null) {
          Object.assign(record, { ok: true, objectId: hit.objectId, txDigest: hit.txDigest, certifiedEpoch: hit.certifiedEpoch, endEpoch: hit.endEpoch, tries });
          break;
        }
        await sleep(pollMs);
      }
      if (!record.ok) throw new Error("chua thay blob certified tren chain");
    } catch (err) {
      Object.assign(record, { ok: false, error: err.message });
    }
    record.totalMs = Date.now() - t0;
    if (logPath) await appendFile(logPath, JSON.stringify(record) + "\n").catch((e) => console.error("[proof] khong ghi log:", e.message));
    console.log(`[proof] ${record.ok ? "OK" : "LOI"} ${namespace} job=${jobId} ${record.ok ? `obj=${record.objectId} end=${record.endEpoch}` : record.error} ${record.totalMs}ms`);
    return record;
  }

  return { confirm };
}
