// ===========================================================================
//  The Cardano Masterpiece — standalone LOCAL DEV server (node:http).
//
//  API routing lives in api/devHandler.ts (shared with the vite dev middleware);
//  this file only adds http + static-file serving for `npm start` against a
//  built dist/. In normal dev just run `npm run dev` (vite on :5173 serves the
//  app AND the API in one process); in production Vercel serves dist/ + api/*.
// ===========================================================================
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, BLOCKFROST_URL } from "./api/_core.ts";
import { apiHandler } from "./api/devHandler.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const server = createServer((req, res) => {
    void (async () => {
        if (await apiHandler(req, res)) return;   // /canvas.bin, /api/*, /bf/*
        // ---- static app (vite build output) with SPA fallback
        const dist = join(__dirname, "dist");
        const url = (req.url ?? "/").split("?")[0];
        const full = join(dist, url === "/" ? "/index.html" : url);
        const serveStatic = (path: string): void => {
            res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
            res.end(readFileSync(path));
        };
        if (existsSync(full) && !full.includes("..")) return serveStatic(full);
        if (existsSync(join(dist, "index.html"))) return serveStatic(join(dist, "index.html"));
        res.writeHead(404, { "content-type": "text/plain" })
            .end("not found (run `npm run build`, or just use `npm run dev`)");
    })();
});

server.listen(config.port, () => {
    console.log(`The Cardano Masterpiece API: http://localhost:${config.port}`);
    console.log(`  chain:  ${config.network} via ${BLOCKFROST_URL}`);
    console.log(`  script: ${config.masterpieceAddress}`);
});
