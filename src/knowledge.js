import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Kho tai lieu nho (~15 file) nen nhet thang vao system prompt, khong can RAG.
// Walrus Memory chi dung cho phan DONG: ban giao, lich su khach, kien thuc team day.
export async function loadKnowledge(rootDir) {
  const files = (await walk(rootDir)).sort();
  const parts = [];
  for (const file of files) {
    const rel = path.relative(rootDir, file);
    parts.push(`=== FILE: ${rel} ===\n${(await readFile(file, "utf8")).trim()}`);
  }
  return { text: parts.join("\n\n"), fileCount: files.length };
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Ma SR/NPP/outlet -> mo ta ngan (tu mock-data), de LLM va canh bao su co biet
// SR nao thuoc NPP/route nao.
export async function loadDirectory(dataDir) {
  const raw = JSON.parse(await readFile(path.join(dataDir, "customers.json"), "utf8"));
  const map = new Map();
  for (const n of raw.npp || []) map.set(n.code, { type: "NPP", label: `${n.name}, vung ${n.region}` });
  for (const s of raw.sr || []) {
    map.set(s.code, { type: "SR", label: `${s.name}, ${s.npp}, route ${s.route}`, npp: s.npp, route: s.route });
  }
  for (const o of raw.outlets || []) {
    map.set(o.code, { type: "OUT", label: `${o.name}, route ${o.route}`, route: o.route });
  }
  return map;
}
