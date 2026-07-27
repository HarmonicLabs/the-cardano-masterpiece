import type { IncomingMessage, ServerResponse } from "node:http";
import { api } from "./_core.js";
import { preflight, send, fail, readRawBody } from "./_http.js";

// Blockfrost proxy — hides the project key server-side. It forwards arbitrary
// blockfrost REST paths, sourcing the base URL + auth from the SAME
// `BlockfrostPluts` instance (`api`) the rest of the server uses — so the proxy,
// the server SDK and the browser SDK can never resolve blockfrost differently.
// When a project id is configured, `api.url` is derived purely from the network
// (https://cardano-<net>.blockfrost.io/api/v0), so the proxy targets mainnet
// regardless of the BLOCKFROST_URL env/const.
//
// Must be a SINGLE top-level function: Vercel (framework: null) doesn't honor the
// `[...path]` catch-all convention, so a nested dynamic route 404s. vercel.json
//   /bf/:path*  ->  /api/bf?__bf=:path*   (original query is preserved)
// and we reconstruct the blockfrost URL from `__bf` + the remaining query.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    const u = new URL(req.url ?? "/api/bf", "http://x");
    const sub = u.searchParams.get("__bf") ?? "";   // e.g. "addresses/addr1.../utxos"
    u.searchParams.delete("__bf");
    const rest = u.searchParams.toString();          // e.g. "count=100&page=1"
    const target = `${api.url}/${sub}${rest ? "?" + rest : ""}`;
    // Expose the (key-free) upstream base so the actual backend is visible in the
    // browser Network tab and prod logs — no guessing whether it hit mainnet.
    res.setHeader("x-bf-upstream", api.url);
    try {
        const headers: Record<string, string> = {};
        if (api.projectId) headers.project_id = api.projectId;
        const init: RequestInit = { method: req.method ?? "GET", headers };
        if (req.method === "POST") {
            const raw = await readRawBody(req);
            init.body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
            headers["content-type"] = req.headers["content-type"] ?? "application/cbor";
        }
        const r = await fetch(target, init);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!r.ok) {
            // surface the real upstream target + status so a prod failure is
            // self-explanatory (the body is blockfrost's own error, passed through)
            console.error(`[bf] upstream ${r.status} ${req.method ?? "GET"} ${target}`);
            res.setHeader("x-bf-status", String(r.status));
        }
        send(res, r.status, buf, r.headers.get("content-type") ?? "application/json");
    } catch (e) {
        console.error(`[bf] proxy error for ${target}:`, e);
        fail(res, new Error(`bf proxy → ${target} failed: ${String((e as Error)?.message ?? e)}`));
    }
}
