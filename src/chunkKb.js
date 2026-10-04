import { readFile } from "node:fs/promises";

// Chia file workflow thanh tung "mau" de retrieval: moi WFn. la 1 mau; phan dau
// (metadata) va cac muc reference (Handling Matrix, Escalation, SLA...) gom theo
// heading. Muc tieu: moi mau la 1 don vi tra cuu doc lap, du ngu canh de tra loi.
export async function chunkWorkflowFile(path) {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const chunks = [];
  let cur = null;

  const isWF = (l) => /^WF\d+[.\s]/.test(l.trim());
  const isSection = (l) => /^#{1,3}\s+/.test(l) || /^\d+\.\s+[A-ZĐ]/.test(l.trim());

  function push() {
    if (cur && cur.body.join("\n").trim()) {
      chunks.push({ title: cur.title, text: `${cur.title}\n${cur.body.join("\n")}`.trim() });
    }
  }

  for (const line of lines) {
    if (isWF(line)) {
      push();
      cur = { title: line.trim(), body: [] };
    } else if (isSection(line)) {
      push();
      cur = { title: line.replace(/^#+\s*/, "").trim(), body: [] };
    } else {
      if (!cur) cur = { title: "Giới thiệu", body: [] };
      cur.body.push(line);
    }
  }
  push();
  // Bo mau qua ngan (vai ky tu), gop vao mau truoc neu can
  return chunks.filter((c) => c.text.length > 40);
}
