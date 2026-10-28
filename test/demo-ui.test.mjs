import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

// Execute the real inline UI script with a minimal DOM and mocked HTTP responses.
// This verifies polling and rendered links without a browser or network dependency.
test("Admin proof polls every seed rule, retries pending results and renders Suiscan links", async () => {
  const html = await readFile(new URL("../demo/public/index.html", import.meta.url), "utf8");
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = "0"; this._text = ""; this.classList = { toggle() {} }; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    append(...nodes) { for (const node of nodes) this.children.push(...(node.tag === "fragment" ? node.children : [node])); }
    replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
    addEventListener() {}
    setAttribute() {}
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element("div")]));
  const rules = Array.from({ length: 6 }, (_, i) => ({ id: `C${i+1}`, jobId: `signed-seed-${i+1}`, category: `Category ${i+1}`,
    system: "Synthetic", target: "Data Team", route: "L2", count: 4, total: 4, confidence: 1 }));
  const calls = [], storage = new Map();
  let first = true;
  const context = vm.createContext({
    document: { hidden: false, getElementById: id => elements.get(id), createElement: tag => new Element(tag), createDocumentFragment: () => new Element("fragment"), querySelectorAll: () => [] },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID }, AbortController, setTimeout, clearTimeout, setInterval() {},
    fetch: async (url) => {
      let data;
      if (url === "/api/rules") data = { rules };
      else if (url === "/api/tickets") data = { tickets: [] };
      else if (url === "/api/health") data = { epoch: 42, blobCount: 6, transport: "Tatum Sui gRPC" };
      else if (url.startsWith("/api/proof?job=")) {
        const job = new URL(url, "http://demo.local").searchParams.get("job");
        calls.push(job);
        const index = rules.findIndex(rule => rule.jobId === job);
        assert.ok(index >= 0);
        if (index === 0 && first) { first = false; data = { status: "pending", proof: null }; }
        else data = { status: "confirmed", proof: { objectId: `0x${index+1}`, txDigest: `Tx${index+1}`, endEpoch: 57, currentEpoch: 42 } };
      } else assert.fail(`Unexpected UI URL: ${url}`);
      return new Response(JSON.stringify(data));
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  for (let i = 0; i < 4; i++) await vm.runInContext("poll()", context);
  assert.equal(calls.length, 7);
  assert.deepEqual([...new Set(calls)].sort(), rules.map(rule => rule.jobId).sort());
  const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
  const links = descendants(elements.get("proofs")).filter(element => element.tag === "a");
  assert.equal(links.length, 12);
  for (let i = 0; i < 6; i++) {
    assert.ok(links.some(a => a.href === `https://suiscan.xyz/mainnet/object/0x${i+1}`));
    assert.ok(links.some(a => a.href === `https://suiscan.xyz/mainnet/tx/Tx${i+1}`));
  }
  assert.ok(links.every(a => a.target === "_blank" && a.rel === "noopener noreferrer"));
  assert.match(elements.get("proofs").textContent, /End epoch 57 · Current epoch 42/);
  assert.deepEqual(JSON.parse(storage.get("total-recall-jobs")), []);
});
