// Test offline (khong goi mang): ham tach ma, header memory, cat tin nhan, tai lieu,
// va luong phat hien su co voi memory gia.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCodes, stamp, parseStamp } from "./memory.js";
import { splitText } from "./zalo.js";
import { loadKnowledge, loadDirectory } from "./knowledge.js";
import { createIncidentDetector } from "./incident.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(extractCodes("SR-1042 loi don OUT-0007, npp-hcm-01, case CS-0924-003, SR-1042"), [
  "SR-1042",
  "OUT-0007",
  "NPP-HCM-01",
  "CS-0924-003",
]);

const s = stamp("An", "don khong vao DMS", ["SR-1042", "OUT-0007"], new Date("2026-09-24T07:05:00Z"));
assert.equal(s, "[2026-09-24 14:05] [An] [SR-1042,OUT-0007] don khong vao DMS");
const meta = parseStamp(s);
assert.equal(meta.author, "An");
assert.deepEqual(meta.codes, ["SR-1042", "OUT-0007"]);
assert.equal(meta.body, "don khong vao DMS");
assert.equal(meta.time.toISOString(), "2026-09-24T07:05:00.000Z");
assert.equal(parseStamp("khong co header"), null);

const parts = splitText("dong\n".repeat(1000));
assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1800));

const kb = await loadKnowledge(path.join(ROOT, "mock-sharepoint"));
assert.ok(kb.fileCount >= 10 && kb.text.includes("escalation-matrix.md"));
const dir = await loadDirectory(path.join(ROOT, "mock-data"));
assert.equal(dir.get("SR-1042").npp, "NPP-HCM-01");

// Memory gia: 2 SR khac da bao loi tuong tu trong 60 phut -> log thu 3 phai bao dong.
const now = new Date();
const fakeMemory = {
  ns: { caselog: "x:team:caselog" },
  recall: async () => [
    { text: stamp("Binh", "don khong vao DMS", ["SR-1077"], new Date(now - 10 * 60000)) },
    { text: stamp("Chi", "don treo khong day DMS", ["SR-2031"], new Date(now - 20 * 60000)) },
    { text: stamp("Dung", "loi cu tu hom qua", ["SR-9999"], new Date(now - 26 * 3600000)) },
  ].map((r) => ({ ...r, meta: parseStamp(r.text) })),
};
const detector = createIncidentDetector({ memory: fakeMemory, directory: dir, windowMinutes: 60, minReports: 3 });
const alert = await detector.check({ body: "don khong vao DMS", codes: ["SR-1042"], author: "An" });
assert.ok(alert && alert.includes("3 SR") && !alert.includes("SR-9999"), alert);
assert.equal(await detector.check({ body: "don khong vao DMS", codes: ["SR-1042"], author: "An" }), null, "khong bao trung");

console.log(`selftest OK (${kb.fileCount} file tai lieu)`);
