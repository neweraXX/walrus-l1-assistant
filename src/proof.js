// "Da nho that chua?" — sau khi relayer bao xong 1 lan remember, tim blob tren chain (Tatum)
// va xac nhan da certify. Ghi moi lan vao logs/proof.jsonl (so cai: ai day, luc nao, blob nao,
// het han epoch nao) de bao cao / truy nguon / canh bao het han ve sau.
import { appendFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = new AsyncLocalStorage();
const RECHECK_MS = 2 * 60_000;
const MAX_RECHECKS = 2;

// Giu dung chat qua cac promise nen, khong dung bien chatId chung.
export function withProofContext(meta, fn) {
  return context.run(meta, fn);
}

export function createProof({ chain, logPath, accountId, pollMs = 5000, chainTimeoutMs = 90_000, onLate = null }) {
  async function ensureOwner() {
    if (!chain.owner) chain.setOwner(await chain.getAccountOwner(accountId));
  }

  async function check(record) {
    record.tries = (record.tries || 0) + 1;
    try {
      await ensureOwner();
      const hit = await chain.findRecentBlob({ blobId: record.blobId, lookback: 10 });
      delete record.checkError;
      if (hit?.certifiedEpoch != null) {
        Object.assign(record, { ok: true, status: "confirmed", objectId: hit.objectId, txDigest: hit.txDigest, certifiedEpoch: hit.certifiedEpoch, endEpoch: hit.endEpoch });
        return true;
      }
    } catch (err) {
      // Loi doc chain khong co nghia la relayer luu that bai.
      record.checkError = err.message;
    }
    return false;
  }

  async function report(record, t0) {
    record.totalMs = Date.now() - t0;
    if (logPath) await appendFile(logPath, JSON.stringify(record) + "\n").catch((e) => console.error("[proof] khong ghi log:", e.message));
    console.log(`[proof] ${record.status.toUpperCase()} ${record.namespace} job=${record.jobId} ${record.ok ? `obj=${record.objectId} end=${record.endEpoch}` : record.error || "dang xac nhan"} ${record.totalMs}ms`);
  }

  function recheck(record, t0, notify) {
    const timer = setTimeout(async () => {
      record.rechecks = (record.rechecks || 0) + 1;
      await check(record);
      await report(record, t0);
      if (!record.ok && record.rechecks < MAX_RECHECKS) recheck(record, t0, notify);
      try {
        await notify?.({ ...record });
      } catch (err) {
        console.error("[proof] onLate loi:", err.message);
      }
    }, RECHECK_MS);
    timer.unref?.();
  }

  // write = { job, done } tu memory.remember(). Timeout chi la pending, khong ghi lai.
  async function confirm(write, { namespace, author, chatId, onLate: notifyLate } = {}) {
    const t0 = Date.now();
    const meta = context.getStore() || {};
    const record = { ts: new Date().toISOString(), namespace, author, jobId: write?.job?.job_id, ok: false, status: "pending" };
    if (chatId ?? meta.chatId) record.chatId = chatId ?? meta.chatId;
    const notify = notifyLate ?? meta.onLate ?? onLate;
    try {
      const r = await write.done; // relayer: embedding + SEAL + upload Walrus
      record.relayerMs = Date.now() - t0;
      record.blobId = r?.blob_id;
      if (!record.blobId) throw new Error("relayer khong tra blob_id");
    } catch (err) {
      Object.assign(record, { status: "failed", error: err.message });
    }
    if (record.status !== "failed") {
      const deadline = Date.now() + chainTimeoutMs;
      while (Date.now() < deadline) {
        if (await check(record)) break;
        const remaining = deadline - Date.now();
        if (remaining > 0) await sleep(Math.min(pollMs, remaining));
      }
    }
    await report(record, t0);
    if (record.status === "pending") recheck(record, t0, notify);
    return { ...record };
  }

  return { confirm };
}
