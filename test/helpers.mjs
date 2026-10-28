import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
export function tmpdir() { mkdirSync(root, { recursive: true }); return root; }
