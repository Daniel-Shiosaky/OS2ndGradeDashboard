// Zero-dependency static file server for local development. Serves
// `public/` (built frontend) and `data/` (JSON event data) so the dashboard
// can be exercised locally without any backend, per Phase 1 of the brief.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "./runGuard.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function resolveRequestPath(urlPath: string): { dir: string; relative: string } {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  if (decoded.startsWith("/data/")) {
    return { dir: DATA_DIR, relative: decoded.slice("/data/".length) };
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  return { dir: PUBLIC_DIR, relative };
}

export function startDevServer(port = PORT) {
  const server = createServer((req, res) => {
    void (async () => {
      const { dir, relative } = resolveRequestPath(req.url ?? "/");
      const filePath = path.join(dir, relative);

      // Prevent path traversal outside the intended root.
      if (!filePath.startsWith(dir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      try {
        const body = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
      }
    })();
  });

  server.listen(port, () => {
    console.log(`Dev server running at http://localhost:${port}`);
  });

  return server;
}

if (isMainModule(import.meta.url)) {
  startDevServer();
}
