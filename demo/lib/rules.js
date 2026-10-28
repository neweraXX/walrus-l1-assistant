import { createHash } from "node:crypto";
import { parseRouteHint } from "../../src/escalation.js";
import { selectRules } from "../../src/routeEval.js";
import { fmtRouteHint } from "../../src/format.js";

export const SEED_NS = "demo:seed";
export const sessionNamespace = (session) => `demo:s:${session}`;
export const ruleKey = (r) => `${r.system.trim().toLowerCase()}::${r.category.trim().toLowerCase()}`;
export const stableId = (r) => `C${100000 + createHash("sha256").update(ruleKey(r)).digest().readUInt32BE(0)}`;
const lineJson = (text, prefix) => {
  try { return JSON.parse(text.split("\n").find((s) => s.startsWith(prefix))?.slice(prefix.length)); }
  catch { return null; }
};

export function evidenceOf(hits) {
  const unique = new Map();
  for (const hit of hits) {
    const rows = lineJson(hit.text || "", "Demo evidence: ");
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && typeof row.key === "string" && typeof row.category === "string" && typeof row.system === "string"
        && ["L1", "L2", "VENDOR"].includes(row.route) && typeof row.target === "string") unique.set(row.key, row);
    }
  }
  return [...unique.values()];
}

export function ruleFromEvidence(rows, id = stableId(rows[0])) {
  const counts = new Map();
  for (const r of rows) {
    const pair = JSON.stringify([r.route, r.route === "L1" ? "" : r.target]);
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  const [pair, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (rows.length < 2 || count / rows.length < 0.6) return null;
  const [route, target] = JSON.parse(pair);
  const latest = rows.at(-1);
  return { id, category: latest.category, system: latest.system, route, target, count, total: rows.length,
    confidence: count / rows.length, l1Action: rows.filter((r) => r.route === route && r.target === target).at(-1)?.l1Action || "",
    lastDate: new Date().toISOString().slice(0, 10), examples: rows.slice(-5).map((r) => r.key) };
}

export function renderRule(rule) {
  return [
    `Routing rule [${rule.id}] ${rule.category} (${rule.system})`,
    `Usually handled by: ${rule.route}${rule.target ? ` ${rule.target}` : ""} (${rule.count}/${rule.total} tickets, ${Math.floor(rule.confidence * 100)}%), latest ${rule.lastDate}`,
    `L1 should: ${rule.l1Action}`,
    `Examples: ${rule.examples.join(", ")}`,
    "Source: automatically learned from closed tickets; at least 2 tickets and 60% agreement.",
  ].join("\n");
}

export function bundleText(rows, rule, at = new Date().toISOString()) {
  return [rule ? renderRule(rule) : "Closed ticket evidence — insufficient agreement for a routing rule.",
    `Demo snapshot: ${JSON.stringify({ key: ruleKey(rows[0]), at })}`,
    `Demo evidence: ${JSON.stringify(rows)}`].join("\n");
}

// Display and inference only use rule TEXT returned by Walrus recall, never a process cache.
export function parseKnowledge(hits) {
  const latest = new Map(), controls = new Map();
  for (const hit of hits) {
    const text = hit.text || "", hint = parseRouteHint(text);
    const snapshot = lineJson(text, "Demo snapshot: ");
    const key = snapshot?.key || (hint && ruleKey(hint));
    if (key) {
      const at = hit.created_at || snapshot?.at || "";
      const evidenceCount = lineJson(text, "Demo evidence: ")?.length || hint?.total || 0;
      const previous = latest.get(key);
      if (!previous || at > previous.at || (at === previous.at && evidenceCount > previous.evidenceCount)) {
        latest.set(key, { ...hit, hint, at, evidenceCount });
      }
    }
    const control = lineJson(text, "Demo control: ");
    if (control && typeof control.key === "string" && ["block", "open"].includes(control.action)
      && (!controls.has(control.key) || control.at > controls.get(control.key).at)) controls.set(control.key, control);
  }
  return [...latest].flatMap(([key, hit]) => {
    if (!hit.hint) return [];
    const examples = /^(?:Examples|Ví dụ ticket):\s*([^\n]*)/m.exec(hit.text)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) || [];
    return [{ ...hit.hint, key, examples, namespace: hit.namespace, distance: hit.distance, blobId: hit.blob_id || null,
      blocked: controls.get(key)?.action === "block", proof: null, text: hit.text }];
  });
}

export async function recallKnowledge(memory, session, query = "Routing rule closed ticket evidence admin block open", options = {}) {
  const groups = await Promise.all([SEED_NS, sessionNamespace(session)].map(async (namespace) => {
    const hits = await memory.recall(namespace, query, { limit: 100, sort: "recent", ...options });
    if (!Array.isArray(hits)) throw new Error("Invalid memory response");
    return hits.map((h) => ({ ...h, namespace }));
  }));
  const hits = groups.flat();
  return { hits, rules: parseKnowledge(hits), evidence: evidenceOf(hits) };
}

export function relevantRules(rules, query) {
  const active = rules.filter((r) => !r.blocked);
  // Distances come from a second semantic recall for the actual question.
  return selectRules(active, null, query).map((r) => active.find((a) => a.text === r.text)).filter(Boolean);
}

export function plainHint(rule) {
  return fmtRouteHint(rule, { language: "en", plain: true });
}
