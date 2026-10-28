// API workflow chay tren localhost cho bot bot production (production) goi sang khi co
// cau hoi workflow trong group L1 that. KHONG poll Zalo (tranh gianh tin voi
// bot production) - chi tra loi qua HTTP. Namespace/knowledge cau hinh qua env rieng
// (l1-service) de tach khoi Bot Walrus (group test).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "./bootstrap.js";

const { cfg, assistant, addendumPath, evalRunner } = await bootstrap({ needZalo: false });
// sync-kb ghi lai con tro kho moi lan nap -> mtime = lan nap kien thuc gan nhat.
const POINTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kb-version.json");

// Nhung gi team "day:" trong N ngay qua (doc tu file addendum) - cho job nhac Ha
// duyet hang tuan: cai nao dung thi gop vao file workflow goc roi chay sync-kb.
async function taughtSince(days) {
  if (!addendumPath) return [];
  const raw = await readFile(addendumPath, "utf8").catch(() => "");
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return raw
    .split(/^## /m)
    .map((block) => {
      const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] (.+?) dạy:\n([\s\S]*)$/.exec(block.trim());
      if (!m) return null;
      return { at: `${m[1]} ${m[2]}`, time: new Date(`${m[1]}T${m[2]}:00+07:00`).getTime(), by: m[3], body: m[4].trim() };
    })
    .filter((x) => x && x.time >= since);
}
const PORT = Number(process.env.WORKFLOW_API_PORT || 8787);
const HOST = "127.0.0.1"; // chi loopback, khong expose ra ngoai

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/taught")) {
    const q = new URL(req.url, "http://x").searchParams;
    const days = Number(q.get("days")) || 7;
    // draft=1: kem de xuat gop vao WF cho tung muc (job review cuoi tuan, cham vai phut).
    return taughtSince(days).then(async (items) => {
      // "Da gop" = co trong kb-merged.json (Claude ghi khi gop vao WF). Truoc 28/09 chua co danh
      // sach -> muc day truoc lan nap gan nhat coi nhu da gop (review 27/09). Tu 28/09 KHONG doan
      // theo ngay nap nua (vd loi day Call Cycle 28/09 chua gop nhung nam truoc lan nap 29/09).
      const syncedAt = (await stat(POINTER).catch(() => null))?.mtimeMs || 0;
      const list = JSON.parse(await readFile(path.join(path.dirname(POINTER), "kb-merged.json"), "utf8").catch(() => "{}")).items || [];
      const mergedSet = new Set(list.map((x) => `${x.by}|${x.at}`));
      const LIST_START = new Date("2026-09-28T00:00:00+07:00").getTime();
      for (const it of items) it.merged = mergedSet.has(`${it.by}|${it.at}`) || (it.time < LIST_START && it.time < syncedAt);
      if (q.get("draft") === "1") for (const it of items) if (!it.merged) it.draft = await assistant.draftMerge(it.body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items, syncedAt }));
    });
  }
  // Ket qua lan test gan nhat (job 07:00 gui Ha).
  if (req.method === "GET" && req.url === "/eval/last") {
    return readFile(path.join(path.dirname(POINTER), "logs", "eval-last.json"), "utf8")
      .then((txt) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(txt);
      })
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  }
  // Chay bo test bot (02:00 + sau deploy). Di cham, ~30 phut.
  // ?only=T1,T2 -> chi chay vai cau, khong ghi de ket qua dem.
  if (req.method === "POST" && (req.url === "/eval" || req.url.startsWith("/eval?"))) {
    const only = (new URL(req.url, "http://x").searchParams.get("only") || "").split(",").map((x) => x.trim()).filter(Boolean);
    return evalRunner
      .run({ only })
      .then((out) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      })
      .catch((err) => {
        res.writeHead(err.message === "dang chay roi" ? 409 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
  }
  // /ask-image: anh chup man hinh (bot production group L1) -> bot doc chu tren anh roi tra loi.
  if (req.method !== "POST" || (req.url !== "/ask" && req.url !== "/ask-image")) {
    res.writeHead(404);
    return res.end();
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1e5) req.destroy(); // chan payload qua lon
  });
  req.on("end", async () => {
    try {
      const { chatId, userId, userName, text, imageUrl, caption } = JSON.parse(body || "{}");
      const replies =
        req.url === "/ask-image"
          ? await assistant.handleImage({ chatId, userId, userName, imageUrl: String(imageUrl || ""), caption: String(caption || "") })
          : await assistant.handle({ chatId, userId, userName, text: String(text || "") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ replies }));
    } catch (err) {
      console.error(`[http] loi: ${err.message}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

// Node mac dinh cat request sau 5 phut -> /eval (chay ca bo test) can lau hon.
server.requestTimeout = 45 * 60 * 1000;
server.listen(PORT, HOST, () =>
  console.log(`Workflow API nghe ${HOST}:${PORT} (namespace=${cfg.namespacePrefix}, KB=${cfg.knowledgeDir}).`)
);
