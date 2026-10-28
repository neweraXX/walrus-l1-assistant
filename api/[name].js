// Vercel discovers functions in the repository-root api directory.
import rules from "../demo/api/rules.js";
import tickets from "../demo/api/tickets.js";
import health from "../demo/api/health.js";
import proof from "../demo/api/proof.js";
import ask from "../demo/api/ask.js";
import learn from "../demo/api/learn.js";
import block from "../demo/api/block.js";
import measure from "../demo/api/measure.js";
const handlers = { rules, tickets, health, proof, ask, learn, block, measure };
export default function handler(req, res) {
  const name = /^\/(?:api|demo\/api)\/([a-z]+)\/?$/.exec(new URL(req.url, "http://demo.local").pathname)?.[1];
  if (handlers[name]) return handlers[name](req, res);
  res.statusCode = 404; res.setHeader("Content-Type", "application/json"); res.end('{"error":"Not found"}');
}
