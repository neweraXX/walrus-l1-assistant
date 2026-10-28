// Explicit, opt-in network operation. This file is never imported by the web app.
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createEscalationLearner, parseRouteHint } from "../src/escalation.js";
import { createRuntime } from "./lib/runtime.js";
import { SEED_NS, ruleKey } from "./lib/rules.js";

export async function seedDemo({ runtime = createRuntime(), statePath = fileURLToPath(new URL("./.seed-state.json", import.meta.url)), reset = false } = {}) {
  const data = JSON.parse(await readFile(new URL("./data/tickets.json", import.meta.url), "utf8"));
  const descriptions = [
    ["MFA enrollment reset", "Collect the sign-in error and request a hosted MFA reset from Northwind Systems."],
    ["Missing order delivery route", "Send the order and missing route association to the Data Team."],
    ["App stuck on synchronization", "Check connectivity, restart FieldGo and clear the local sync queue."],
    ["Sensor pairing interrupted", "Enable Bluetooth, remove the stale pairing and follow the pairing guide."],
    ["Promotion price mismatch", "Send the campaign and checkout price discrepancy to the Commerce Data Team."],
    ["Hosted payment callback signature", "Send the callback verification error to Northwind Systems for a connector configuration fix."],
  ];
  const tickets = data.map((r, i) => ({ ...r, category: descriptions[Math.floor(i / 4)][0], l1Action: descriptions[Math.floor(i / 4)][1] }));
  const byKey = new Map(tickets.map((r) => [r.key, r]));
  const jobs = [], proofs = [];
  let writeFailures = 0;
  // Local learner state is only a seed-script checkpoint, never web runtime state.
  if (reset) await rm(statePath, { force: true });
  const learner = createEscalationLearner({
    namespace: SEED_NS, language: "en", statePath, llmGapMs: 0,
    runTool: async ({ tool, params }) => tool === "ticket_da_dong"
      ? tickets.map((r) => `${r.key} | ${r.system} | ${r.route === "L1" ? "Level 1" : "Level 2"} | ${r.target || "L1"} | 2026-10-24 | ${r.summary}`).join("\n")
      : JSON.stringify(byKey.get(params.key)),
    // Fixture fields already contain the closed-ticket outcome. No LLM or holdout is needed to seed.
    ask: async ({ prompt }) => {
      const ticket = JSON.parse(prompt.split("HỒ SƠ TICKET:\n")[1]);
      return JSON.stringify({ ...ticket, symptom: ticket.summary, fix: ticket.resolution });
    },
    memory: { remember: async (namespace, content) => {
      const rule = parseRouteHint(content);
      if (!rule) throw new Error("Seed learner produced an invalid rule");
      const rows = tickets.filter((t) => ruleKey(t) === ruleKey(rule));
      const bundled = `${content}\nDemo snapshot: ${JSON.stringify({ key: ruleKey(rule), at: new Date().toISOString() })}\nDemo evidence: ${JSON.stringify(rows)}`;
      let job;
      try {
        job = await runtime.memory.remember(namespace, bundled);
        if (!job?.job_id) throw new Error("Seed write did not return a job ID");
      } catch (error) { writeFailures++; throw error; }
      jobs.push({ jobId: job.job_id, category: rule.category });
      console.log(`Accepted ${rule.id}: ${rule.category} (${rule.count}/${rule.total}); job=${job.job_id}`);
      return { job };
    } },
  });
  const result = await learner.runDaily({ days: 14, max: 30 });
  if (result.failed || writeFailures) throw new Error(`${result.failed + writeFailures} fixture tickets or rule writes failed to seed`);
  console.log(`Learner processed ${result.checked} closed tickets. Rules are used automatically at >=2 tickets and >=60% agreement.`);
  // Poll synchronously in this local script; web proof checks use independent requests.
  for (const job of jobs) {
    let state;
    for (let i = 0; i < 120; i++) {
      state = await runtime.memory.status(job.jobId);
      if (state.status === "failed") throw new Error(`Seed write failed: ${job.jobId}. Rerun with --reset.`);
      if (state.blob_id && state.status === "done") break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!state?.blob_id) throw new Error(`Seed is still pending: ${job.jobId}. Check the relayer before rerunning with --reset.`);
    const chain = await runtime.getChain();
    const hit = await chain.findRecentBlob({ blobId: state.blob_id, jobId: job.jobId });
    const proof = { category: job.category, jobId: job.jobId, status: hit?.certifiedEpoch != null ? "confirmed" : "pending", proof: hit || null };
    proofs.push(proof);
    console.log(JSON.stringify(proof));
  }
  if (!jobs.length) console.log("Seed checkpoint already exists. Use --reset only to deliberately reseed.");
  const rules = await learner.listRules();
  console.log(JSON.stringify(rules, null, 2));
  return { result, rules, jobs, proofs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedDemo({ reset: process.argv.includes("--reset") }).catch(() => { console.error("Seed failed. Check the printed jobs, environment and relayer status before retrying."); process.exitCode = 1; });
}
