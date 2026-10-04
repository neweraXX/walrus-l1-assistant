// Nap kho tai lieu (KNOWLEDGE_DIR, mac dinh mock-sharepoint/) len Walrus Memory de bot tra
// cuu theo nghia (RAG). Moi file .md cat theo heading thanh tung "mau"; file workflow matrix
// (WFxx) cat theo tung WF. Dong thoi ghi kb-cache/<namespace>.json lam kho du phong khi
// relayer Walrus cham/loi.
//   node src/kbIndex.js            (nap len mainnet + ghi du phong)
//   node src/kbIndex.js --dry      (chi cat mau + ghi du phong, khong nap)
// Walrus Memory chi ghi them (khong xoa) -> chay lai se nap trung; muon nap lai sach thi doi
// NAMESPACE_PREFIX.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createMemory } from "./memory.js";
import { chunkDoc } from "./chunkDoc.js";
import { chunkWorkflowFile } from "./chunkKb.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry");

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

const cfg = loadConfig({ needZalo: false });
const KB_NS = `${cfg.namespacePrefix}:kb`;
const dir = path.join(ROOT, cfg.knowledgeDir);

const items = [];
for (const f of await walk(dir)) {
  const chunks = /workflow-matrix|Workflow_Matrix/i.test(f) ? (await chunkWorkflowFile(f)).map((c) => c.text) : await chunkDoc(f);
  for (const text of chunks) items.push({ text, namespace: KB_NS });
  console.log(`  ${path.relative(ROOT, f)}: ${chunks.length} mau`);
}

const cacheDir = path.join(ROOT, "kb-cache");
await mkdir(cacheDir, { recursive: true });
await writeFile(path.join(cacheDir, `${KB_NS}.json`), JSON.stringify(items.map((x) => x.text)));
console.log(`=> Ghi du phong ${items.length} mau -> kb-cache/${KB_NS}.json`);
if (dry) process.exit(0);

const memory = createMemory({ ...cfg.memwal, prefix: cfg.namespacePrefix });
console.log(`=> Nap ${items.length} mau vao ${KB_NS} (Walrus mainnet)...`);
const t = Date.now();
// Relayer gioi han 20 item / lan bulk -> tu chia lo.
for (let i = 0; i < items.length; i += 20) {
  await memory.client.rememberBulkAndWait(items.slice(i, i + 20));
  console.log(`   ...${Math.min(i + 20, items.length)}/${items.length} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
}
console.log(`Xong ${items.length} mau vao ${KB_NS} sau ${((Date.now() - t) / 1000).toFixed(0)}s.`);
process.exit(0);
