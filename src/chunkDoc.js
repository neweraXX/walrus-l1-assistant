import { readFile } from "node:fs/promises";
import path from "node:path";

// Chia 1 file .md bat ky thanh cac mau theo heading (#/##/###). Mau qua to thi
// cat nho theo kich thuoc. Moi mau gan tien to "FILE > heading" de retrieval co
// ngu canh (biet mau thuoc file/muc nao).
const MAX = 3200;
const MIN = 60;

export async function chunkDoc(filePath) {
  const name = path.basename(filePath);
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const stack = []; // [{level, title}]
  const sections = [];
  let cur = { path: name, body: [] };

  function flush() {
    const text = cur.body.join("\n").trim();
    if (text) sections.push({ path: cur.path, text });
    cur = { path: pathLabel(), body: [] };
  }
  function pathLabel() {
    return [name, ...stack.map((s) => s.title)].join(" > ");
  }

  for (const line of lines) {
    const m = /^(#{1,4})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      cur.path = pathLabel();
    } else {
      cur.body.push(line);
    }
  }
  flush();

  // Cat mau qua to + bo mau qua nho
  const out = [];
  for (const s of sections) {
    if (s.text.length <= MAX) {
      if (s.text.length >= MIN) out.push(`[${s.path}]\n${s.text}`);
      continue;
    }
    const paras = s.text.split(/\n\s*\n/);
    let buf = "";
    for (const p of paras) {
      if ((buf + "\n\n" + p).length > MAX && buf) {
        out.push(`[${s.path}]\n${buf.trim()}`);
        buf = p;
      } else {
        buf = buf ? `${buf}\n\n${p}` : p;
      }
    }
    if (buf.trim().length >= MIN) out.push(`[${s.path}]\n${buf.trim()}`);
  }
  return out;
}
