// Kho DU PHONG tren dia khi Walrus Memory cham/loi (da gap 25/09: 502, 504
// RECALL_TIMEOUT o buoc seal_decrypt). Walrus van la nguon chinh; ban nay chi
// dung khi recall that bai, de bot van tra loi DUNG NGUON thay vi bao "khong co"
// hoac bia. Tim theo tu khoa (khong theo nghia) nen dat nguong kha chat.
//
// Nguon:
// - kb-cache/<namespace>.json: dung cac mau tai lieu da nap len Walrus (sync-kb ghi ra)
// - file addendum: moi lan "day:" deu ghi them vao day
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const STOP = new Set(
  "la gi thi cho cua va co khong ko nhu the nao sao lam nhe nha minh ban toi tao may cai nay do voi de duoc bi o tren trong khi neu hay hoac thi ma cac nhung mot phai roi van con da dang se user a e anh chi em oi vay the".split(" ")
);
const MIN_COVERAGE = 0.5; // phai khop >= 50% trong so tu khoa cua cau hoi
const MIN_MATCHED = 2;

export function tokens(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function buildIndex(docs) {
  const items = docs.map((d) => {
    const toks = tokens(d.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { ...d, tf, len: toks.length };
  });
  const df = new Map();
  for (const it of items) for (const t of it.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = items.length || 1;
  const avgLen = items.reduce((s, it) => s + it.len, 0) / n || 1;
  // BM25: tu cang pho bien (don, hang, dms...) cang it diem; mau cang dai cang bi tru.
  const idf = (t) => Math.log(1 + (n - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const K1 = 1.2;
  const B = 0.75;
  return {
    size: items.length,
    search(query, limit = 4) {
      // Tu khong xuat hien trong kho nao thi bo qua (khong the khop, dung de tinh ty le).
      const q = [...new Set(tokens(query))].filter((t) => df.has(t));
      if (!q.length) return [];
      const total = q.reduce((s, t) => s + idf(t), 0) || 1;
      return items
        .map((it) => {
          const hit = q.filter((t) => it.tf.has(t));
          const coverage = hit.reduce((s, t) => s + idf(t), 0) / total;
          const bm25 = hit.reduce((s, t) => {
            const tf = it.tf.get(t);
            return s + (idf(t) * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * it.len) / avgLen));
          }, 0);
          return { it, matched: hit.length, coverage, bm25 };
        })
        .filter((x) => x.matched >= Math.min(MIN_MATCHED, q.length) && x.coverage >= MIN_COVERAGE)
        .sort((a, b) => b.bm25 - a.bm25)
        .slice(0, limit)
        .map((x) => ({ text: x.it.text, meta: x.it.meta ?? null, distance: 1 - x.coverage, fallback: true }));
    },
  };
}

// Doc lai file khi mtime doi (sync-kb / "day:" moi) - khong can restart bot.
function cachedLoader(load) {
  const cache = new Map(); // key -> { mtime, index }
  return async (file, ...args) => {
    try {
      const { mtimeMs } = await stat(file);
      const hit = cache.get(file);
      if (hit && hit.mtime === mtimeMs) return hit.index;
      const index = buildIndex(await load(file, ...args));
      cache.set(file, { mtime: mtimeMs, index });
      return index;
    } catch {
      return null; // chua co file du phong
    }
  };
}

const loadKbFile = cachedLoader(async (file) => JSON.parse(await readFile(file, "utf8")).map((text) => ({ text })));

// "## [2026-09-25 14:53] Dung dạy:\n<noi dung>" -> "[2026-09-25 14:53] [Dung] <noi dung>"
// (cung dang voi memory tren Walrus de parseStamp/nhan nguon dung nhu thuong).
export function parseAddendum(raw) {
  return String(raw)
    .split(/^## /m)
    .map((block) => {
      const m = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+?) dạy:\n([\s\S]*)$/.exec(block.trim());
      return m ? { at: m[1], by: m[2], body: m[3].trim() } : null;
    })
    .filter(Boolean);
}

// Ngay "cap nhat" gan vao mau luc nap = ngay sua CA FILE -> sua 1 WF thi moi WF deu
// thanh "moi" (ca 25/09: WF1 cu mang ngay 25/09, de len chi dan Binh vua day).
// chunk-dates.json (sync-kb ghi) luu ngay NOI DUNG TUNG MAU xuat hien lan dau.
export const DATE_TAG = / ?\(cập nhật (\d{4}-\d{2}-\d{2})\) ?/;
export function chunkBodyHash(text) {
  return createHash("sha1").update(String(text).replace(DATE_TAG, "")).digest("hex");
}

export function createLocalKb({ cacheDir, addendumPath, parseStamp }) {
  let dates = { mtime: -1, map: {} };
  async function chunkDates() {
    if (!cacheDir) return {};
    const file = path.join(cacheDir, "chunk-dates.json");
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs !== dates.mtime) dates = { mtime: mtimeMs, map: JSON.parse(await readFile(file, "utf8")) };
    } catch {
      dates = { mtime: -1, map: {} };
    }
    return dates.map;
  }
  const loadTaught = cachedLoader(async (file) =>
    parseAddendum(await readFile(file, "utf8")).map((e) => {
      const text = `[${e.at}] [${e.by}] ${e.body}`;
      return { text, meta: parseStamp(text) };
    })
  );

  // Nap theo mau: mau cu (ban truoc khi sua) VAN nam tren Walrus -> chi giu mau co van
  // tay trong live-chunks.json cua namespace do. Namespace khong co trong file -> giu het.
  let live = { mtime: -1, map: {} };
  async function liveChunks() {
    if (!cacheDir) return {};
    const file = path.join(cacheDir, "live-chunks.json");
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs !== live.mtime) {
        const raw = JSON.parse(await readFile(file, "utf8"));
        live = { mtime: mtimeMs, map: Object.fromEntries(Object.entries(raw).map(([ns, arr]) => [ns, new Set(arr)])) };
      }
    } catch {
      live = { mtime: -1, map: {} };
    }
    return live.map;
  }

  return {
    async filterLive(namespace, hits) {
      const set = (await liveChunks())[namespace];
      return set ? hits.filter((h) => set.has(chunkBodyHash(h.text))) : hits;
    },
    // Doi "(cap nhat <ngay sua file>)" thanh ngay noi dung mau do thay doi that.
    async fixDates(hits) {
      const map = await chunkDates();
      return hits.map((h) => {
        const d = map[chunkBodyHash(h.text)];
        return d && DATE_TAG.test(h.text) ? { ...h, text: h.text.replace(DATE_TAG, (m) => m.replace(/\d{4}-\d{2}-\d{2}/, d)) } : h;
      });
    },
    async searchKb(namespace, query, limit) {
      if (!cacheDir) return null;
      const idx = await loadKbFile(path.join(cacheDir, `${namespace}.json`));
      return idx ? idx.search(query, limit) : null;
    },
    async searchTaught(query, limit) {
      if (!addendumPath) return null;
      const idx = await loadTaught(addendumPath);
      return idx ? idx.search(query, limit) : null;
    },
  };
}
