import { MemWal } from "@mysten-incubation/memwal";

const CODE_RE = /\b(?:SR-\d{3,5}|OUT-\d{3,5}|NPP-[A-Z]{2,3}-\d{2}|CS-\d{4}-\d{3})\b/gi;
const STAMP_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] \[([^\]]+)\](?: \[([^\]]+)\])? ?([\s\S]*)$/;

const stampFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function extractCodes(text) {
  return [...new Set((text.match(CODE_RE) || []).map((c) => c.toUpperCase()))];
}

export function nowStamp(date = new Date()) {
  return stampFormat.format(date); // "2026-09-24 14:05" (gio VN)
}

// Moi memory mang 1 header "[thoi gian] [nguoi ghi] [ma lien quan]" de khi recall
// biet ai ghi, luc nao, va loc theo khung gio (vd su co trong 60 phut).
export function stamp(author, text, codes = [], date = new Date()) {
  const who = String(author || "?").replace(/[[\]]/g, "");
  const codePart = codes.length ? ` [${codes.join(",")}]` : "";
  return `[${nowStamp(date)}] [${who}]${codePart} ${text}`;
}

export function parseStamp(text) {
  const m = STAMP_RE.exec(text || "");
  if (!m) return null;
  return {
    time: new Date(`${m[1]}T${m[2]}:00+07:00`),
    author: m[3],
    codes: m[4] ? m[4].split(",") : [],
    body: m[5],
  };
}

export function createMemory({ key, accountId, serverUrl, prefix }) {
  const client = MemWal.create({ key, accountId, serverUrl });

  const ns = {
    kb: `${prefix}:kb`, // KB chung (workflow + tai lieu L1) - moi group tra duoc
    kbpriv: `${prefix}:kbpriv`, // KB rieng (chuyen sau/incident) - chi group nguoi than
    handover: `${prefix}:team:handover`,
    knowledge: `${prefix}:team:knowledge`,
    caselog: `${prefix}:team:caselog`,
    auto: `${prefix}:team:auto`,
    customer: (code) => `${prefix}:customer:${code}`,
    personal: (userId) => `${prefix}:personal:${userId}`,
  };

  const pending = new Set();

  // Tra ve ngay khi relayer nhan job (khong bat nguoi dung cho embedding + SEAL +
  // upload Walrus, do thuc te ~30s/lan). `done` resolve khi da index xong.
  async function remember(namespace, text) {
    const job = await client.remember(text, namespace);
    const done = client.waitForRememberJob(job.job_id);
    pending.add(done);
    done
      .then((r) => console.log(`[memory] luu xong ${namespace} job=${job.job_id} ${r?.blob_id ? `blob=${r.blob_id}` : ""}`))
      .catch((err) => console.error(`[memory] job ${job.job_id} (${namespace}) LOI:`, err.message))
      .finally(() => pending.delete(done));
    return { job, done };
  }

  // Cho moi lan ghi dang chay index xong (dung cho script demo/test).
  async function flush() {
    await Promise.allSettled([...pending]);
  }

  // Tu dong trich xuat FACT tu 1 doan chat roi luu (khong luu chat tho). Relayer
  // tu bo qua cau khong co thong tin (fact_count = 0), nen khong luu rac. Chay nen.
  async function analyze(namespace, text) {
    try {
      const r = await client.analyze(text, namespace);
      if (r?.fact_count) console.log(`[memory] auto-nho ${r.fact_count} fact -> ${namespace}`);
      return r;
    } catch (err) {
      console.error(`[memory] analyze (${namespace}) loi:`, err.message);
    }
  }

  async function recall(namespace, query, { limit = 5, maxDistance, sort } = {}) {
    const params = { query, namespace, limit };
    if (maxDistance !== undefined) params.maxDistance = maxDistance;
    if (sort) params.sort = sort;
    const res = await client.recall(params);
    return (res?.results || []).map((r) => ({ ...r, namespace, meta: parseStamp(r.text) }));
  }

  return { client, ns, remember, recall, flush, analyze };
}
