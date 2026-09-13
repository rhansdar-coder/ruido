#!/usr/bin/env node
// The smallest possible static server, so the dashboard can be opened with one
// command. It exists because ES modules will not load over file://, and asking
// someone to install a dev server to view a zero-dependency project would be
// absurd.
//
// Binds to loopback only. This serves local files; it is not a public server.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    // Normalise first, then confirm the result is still inside ROOT. Without
    // this, ../ in a URL walks out of the project directory.
    const target = resolve(join(ROOT, normalize(pathname)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      response.writeHead(403).end("forbidden");
      return;
    }

    const body = await readFile(target);
    response.writeHead(200, {
      "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Ruido dashboard  →  http://127.0.0.1:${PORT}`);
  console.log("Ctrl+C to stop. Loopback only; nothing is exposed to the network.");
});
