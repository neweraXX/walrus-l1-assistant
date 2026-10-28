import { MemWal } from "@mysten-incubation/memwal";
import { createChain } from "../../src/chain.js";
import { readFile } from "node:fs/promises";

export function createRuntime(env = process.env) {
  const required = (name) => { if (!env[name]) throw Object.assign(new Error("Demo environment is not configured."), { status: 503, expose: true }); return env[name]; };
  let client, chainReady;
  const getClient = () => client ||= MemWal.create({ key: required("MEMWAL_PRIVATE_KEY"), accountId: required("MEMWAL_ACCOUNT_ID"),
    serverUrl: env.MEMWAL_SERVER_URL, requestTimeoutMs: 8000 });
  return {
    secret: env.DEMO_COOKIE_SECRET || env.MEMWAL_PRIVATE_KEY || "local-unconfigured-demo",
    memory: {
      async recall(namespace, query, options) { return (await getClient().recall({ namespace, query, ...options })).results; },
      remember: (namespace, text) => getClient().remember(text, namespace),
      status: (jobId) => getClient().getRememberStatus(jobId),
    },
    async ask({ system, prompt, signal, timeoutMs = 18000 }) {
      const endpoint = `${required("LLM_BASE_URL").replace(/\/$/, "")}/chat/completions`;
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${required("LLM_API_KEY")}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: required("LLM_MODEL"), temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
      if (!response.ok) throw Object.assign(new Error("Prediction service is unavailable."), { httpStatus: response.status });
      return (await response.json()).choices?.[0]?.message?.content || "";
    },
    getChain({ signal } = {}) {
      // Publish only a fully initialized adapter. Concurrent health/proof requests share
      // both owner resolution and the adapter's throttle + complete blob-scan snapshot.
      return chainReady ||= (async () => {
        const chain = createChain({ apiKey: required("TATUM_API_KEY"), grpcUrl: env.TATUM_SUI_GRPC, transport: "grpc", owner: env.WALLET_ADDRESS || "", maxRetries: 0 });
        if (!chain.owner) chain.setOwner(await chain.getAccountOwner(required("MEMWAL_ACCOUNT_ID"), { signal }));
        if (!chain.owner) throw new Error("Missing gRPC account owner");
        return chain;
      })().catch(error => { chainReady = null; throw error; });
    },
    tickets: () => readFile(new URL("../data/tickets.json", import.meta.url), "utf8").then(JSON.parse),
    holdout: () => readFile(new URL("../data/holdout.json", import.meta.url), "utf8").then(JSON.parse),
  };
}

let sharedRuntime;
export const getRuntime = () => sharedRuntime ||= createRuntime();
