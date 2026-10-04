// Kiem tra ket noi truoc khi chay that:
//   docker compose run --rm l1-assistant node src/check.js           (chi doc)
//   docker compose run --rm l1-assistant node src/check.js --write   (ghi thu 1 memory len mainnet)
import { bootstrap } from "./bootstrap.js";
import { createZaloClient } from "./zalo.js";

const { cfg, memory, ask, knowledge } = await bootstrap({ needZalo: false });
let failed = false;

async function step(name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`OK   ${name} (${Date.now() - t}ms)${out ? ` -> ${out}` : ""}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

console.log(`Tai lieu: ${knowledge.fileCount} file. Relayer: ${cfg.memwal.serverUrl}\n`);

await step("MemWal health", async () => JSON.stringify(await memory.client.health()));
await step("LLM", async () => ask({ system: "Tra loi dung 1 tu.", prompt: "Noi 'ok'." }));

if (cfg.zaloToken) {
  await step("Zalo getMe", async () => {
    const me = await createZaloClient(cfg.zaloToken).getMe();
    if (!me?.ok) throw new Error(JSON.stringify(me));
    return me.result?.display_name;
  });
} else {
  console.log("SKIP Zalo (chua co ZALO_BOT_TOKEN)");
}

if (process.argv.includes("--write")) {
  const ns = `${cfg.namespacePrefix}:healthcheck`;
  await step("MemWal rememberAndWait (mainnet)", async () => {
    const r = await memory.client.rememberAndWait(`healthcheck ${new Date().toISOString()}`, ns);
    return `blob=${r.blob_id}`;
  });
  await step("MemWal recall", async () => {
    const r = await memory.client.recall({ query: "healthcheck", namespace: ns, limit: 1 });
    return `${r.total} ket qua`;
  });
}

process.exit(failed ? 1 : 0);
