import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createMemory } from "./memory.js";
import { createLlm } from "./llm.js";
import { loadKnowledge, loadDirectory } from "./knowledge.js";
import { createIncidentDetector } from "./incident.js";
import { createAssistant } from "./assistant.js";
import { createEvalRunner } from "./eval.js";
import { createChain } from "./chain.js";
import { createProof } from "./proof.js";
import { createEscalationLearner } from "./escalation.js";
import { createRouteEval } from "./routeEval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


export async function bootstrap({ needZalo = true } = {}) {
  const TOOL_URL = process.env.TOOL_URL || "";
  const cfg = loadConfig({ needZalo });
  const memory = createMemory({ ...cfg.memwal, prefix: cfg.namespacePrefix });
  const ask = createLlm(cfg.llm);
  // Chuan hoa cau day (it khi, can chinh xac) -> uu tien model du phong manh hon model chinh (lite).
  const [strong, ...rest] = cfg.llm.fallbackModels;
  const askStrong = strong ? createLlm({ ...cfg.llm, model: strong, fallbackModels: [...rest, cfg.llm.model] }) : ask;
  const knowledge = await loadKnowledge(path.join(ROOT, cfg.knowledgeDir));
  const directory = await loadDirectory(path.join(ROOT, "mock-data"));
  const incident = createIncidentDetector({ memory, directory, ...cfg.incident });
  const addendumPath = cfg.addendumFile ? path.join(ROOT, cfg.addendumFile) : "";
  // Tatum (chi doc chain): co key moi bat. Khong co -> bot chay y nhu cu.
  const chain = cfg.tatum.apiKey ? createChain({ ...cfg.tatum, owner: cfg.tatum.wallet }) : null;
  const proof = chain ? createProof({ chain, accountId: cfg.memwal.accountId, logPath: path.join(ROOT, "logs", "proof.jsonl") }) : null;
  const namespace = process.env.ESCALATION_NS || `${cfg.namespacePrefix}:escalation`;
  const labelsPath = path.resolve(ROOT, process.env.HOLDOUT_LABELS || "eval/holdout/holdout-labels.json");
  const textPath = path.resolve(ROOT, process.env.HOLDOUT_TEXT || "eval/holdout/holdout-text.json");
  let excludeKeys = new Set();
  try {
    const labels = JSON.parse(await readFile(labelsPath, "utf8"));
    if (!Array.isArray(labels.items) || labels.items.some((r) => typeof r.key !== "string" || !r.key)) throw new Error("Invalid holdout keys");
    excludeKeys = new Set(labels.items.map((r) => r.key));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // ticket_da_dong / ticket_goi_y: private gateway, not included.
  const runTool = async (tool, user) => {
    if (!TOOL_URL) throw new Error("Ticket gateway is not configured");
    const response = await fetch(TOOL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...tool, ...user }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error("Ticket gateway failed");
    return (await response.json()).text;
  };
  const escalation = createEscalationLearner({ runTool, ask, memory, proof, namespace, excludeKeys, statePath: path.join(ROOT, "state", "escalation.json") });
  const routeEval = createRouteEval({ ask: createLlm({ ...cfg.llm, fallbackModels: [], textTimeoutMs: 25000 }), memory, namespace, labelsPath, textPath, logPath: path.join(ROOT, "logs", "route-eval.jsonl") });
  const assistant = createAssistant({
    escalationNamespace: namespace,
    proof,
    memory,
    ask,
    askStrong,
    knowledge,
    directory,
    incident,
    usageLogPath: path.join(ROOT, "logs", "usage.jsonl"),
    addendumPath,
    includePrivateKb: cfg.includePrivateKb,
    kbPointerPath: path.join(ROOT, "kb-version.json"),
    kbCacheDir: path.join(ROOT, "kb-cache"),
    mergedPath: path.join(ROOT, "kb-merged.json"),
    // Moi service 1 file (Bot Walrus = private, bot production qua workflow API = l1).
    statePath: path.join(ROOT, "state", `sessions-${cfg.includePrivateKb ? "private" : "l1"}.json`),
    // Cong cu Jira/call center: CHI bat khi co TOOL_URL (dich vu cong cu rieng, chi doc, KHONG nam
    // trong repo nay vi giu token he thong noi bo). Khong co TOOL_URL -> bot chi tra loi tu tai lieu + memory.
    // Co TOOL_URL: group L1 + tin RIENG voi Bot Walrus; KHONG bat cho group khac (chatId "zgr-...").
    jiraTools: !TOOL_URL ? false : cfg.includePrivateKb ? (chatId) => !String(chatId || "").startsWith("zgr-") : true,
    // Bo nao chi gui {tool, params} va doc lai ket qua da dinh dang; token nam ben dich vu cong cu.
    runTool: !TOOL_URL ? null : async ({ tool, params }, { userId, userName }) => {
      const res = await fetch(TOOL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, params, userId, userName }),
        signal: AbortSignal.timeout(90000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data.text;
    },
  });
  const evalRunner = createEvalRunner({
    memory,
    ask,
    askStrong,
    directory,
    kbPointerPath: path.join(ROOT, "kb-version.json"),
    kbCacheDir: path.join(ROOT, "kb-cache"),
    casesPath: path.join(ROOT, "eval", "cases.json"),
    lastPath: path.join(ROOT, "logs", "eval-last.json"),
  });
  return { cfg, memory, ask, knowledge, assistant, addendumPath, evalRunner, chain, escalation, routeEval };
}
