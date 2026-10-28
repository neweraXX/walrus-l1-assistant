import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const api = Object.fromEntries(await Promise.all(["rules", "tickets", "health", "proof", "ask", "learn", "block", "measure"].map(async (name) => [name, (await import(`./api/${name}.js`)).default])));
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost:3010");
    const name = /^\/api\/([a-z]+)\/?$/.exec(url.pathname)?.[1];
    if (name && api[name]) return api[name](req, res);
    if (req.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(await readFile(new URL("./public/index.html", import.meta.url)));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"Not found"}');
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3010);
  createServer().listen(port, "127.0.0.1", () => console.log(`Total Recall demo: http://localhost:${port}`));
}
