// Index nhieu file .md vao 1 namespace Walrus (RAG). Doc danh sach file tu 1
// manifest JSON: { "namespace": [ "abs/path.md", ... ], ... }
//   node src/indexDocs.js <manifest.json>
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createMemory } from "./memory.js";
import { chunkDoc } from "./chunkDoc.js";
import { chunkWorkflowFile } from "./chunkKb.js";
import { chunkBodyHash } from "./localKb.js";

// File workflow matrix cat theo WFn (bo cat rieng), con lai cat theo heading.
const WORKFLOW_FILE_RE = /Workflow_Matrix|workflow-matrix/i;

// Gan ngay cap nhat file vao dong dau moi mau -> LLM so duoc voi kien thuc team
// day (chi dan day SAU ngay tai lieu cap nhat thi uu tien chi dan, va nguoc lai).
function withDate(text, date) {
  return /^\[[^\n]*\]/.test(text) ? text.replace(/^(\[[^\n]*\])/, `$1 (cập nhật ${date})`) : `(cập nhật ${date}) ${text}`;
}

// Relayer thinh thoang tra 502/503 thoang qua -> thu lai lo do thay vi bo ca kho.
async function withRetry(fn, label, waits = [10, 30, 60, 120]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= waits.length) throw err;
      console.warn(`   ! ${label} loi (${String(err.message).slice(0, 80)}), thu lai sau ${waits[attempt]}s...`);
      await new Promise((r) => setTimeout(r, waits[attempt] * 1000));
    }
  }
}

// --dump <thu muc>: ghi them <namespace>.json (dung cac mau da nap) lam kho du phong
// cho bot khi Walrus loi. --no-upload: chi ghi file, khong nap Walrus.
const argv = process.argv.slice(2);
const dumpDir = argv.includes("--dump") ? argv[argv.indexOf("--dump") + 1] : "";
const upload = !argv.includes("--no-upload");
const manifestPath = argv[0];
const PAUSE_MS = Number(process.env.KB_BATCH_PAUSE_MS || 5000);
// --skip-hashes <file.json>: mau co van tay nay DA co tren Walrus -> khong nap lai
// (nap theo mau: sua 1 WF chi nap dung mau do).
const skipFile = argv.includes("--skip-hashes") ? argv[argv.indexOf("--skip-hashes") + 1] : "";
const skip = new Set(skipFile ? JSON.parse(await readFile(skipFile, "utf8")) : []);
if (!manifestPath) {
  console.error("Thieu manifest. Dung: node src/indexDocs.js <manifest.json>");
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const cfg = loadConfig({ needZalo: false });
const memory = createMemory({ ...cfg.memwal, prefix: cfg.namespacePrefix });

for (const [namespace, files] of Object.entries(manifest)) {
  const items = [];
  for (const f of files) {
    try {
      const date = (await stat(f)).mtime.toISOString().slice(0, 10);
      const chunks = WORKFLOW_FILE_RE.test(f) ? (await chunkWorkflowFile(f)).map((c) => c.text) : await chunkDoc(f);
      for (const text of chunks) items.push({ text: withDate(text, date), namespace });
      console.log(`  ${f}: ${chunks.length} mau`);
    } catch (err) {
      console.error(`  BO QUA ${f}: ${err.message}`);
    }
  }
  if (dumpDir) {
    await mkdir(dumpDir, { recursive: true });
    await writeFile(path.join(dumpDir, `${namespace}.json`), JSON.stringify(items.map((it) => it.text)));
    console.log(`=> Ghi du phong ${items.length} mau -> ${dumpDir}/${namespace}.json`);
  }
  if (!upload) continue;
  const todo = items.filter((it) => !skip.has(chunkBodyHash(it.text)));
  if (skip.size) console.log(`=> ${items.length - todo.length} mau khong doi (bo qua), ${todo.length} mau moi/sua can nap`);
  items.length = 0;
  items.push(...todo);
  console.log(`\n=> Index ${items.length} mau vao ${namespace}...`);
  const t = Date.now();
  for (let i = 0; i < items.length; i += 20) {
    await withRetry(() => memory.client.rememberBulkAndWait(items.slice(i, i + 20)), `lo ${i / 20 + 1}`);
    // Nghi giua cac lo: nap hang loat chiem han muc cua tai khoan/relayer -> bot tra cuu
    // (recall) bi cham/timeout trong luc nap (thay ca 2 lan 25/09). Chua cho bot tho.
    if (i + 20 < items.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
    console.log(`   ...${Math.min(i + 20, items.length)}/${items.length} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
  console.log(`=> Xong ${items.length} mau vao ${namespace} (${((Date.now() - t) / 1000).toFixed(0)}s)\n`);
}
process.exit(0);
