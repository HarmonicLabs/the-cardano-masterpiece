import type { IncomingMessage, ServerResponse } from "node:http";
import { BLOCKFROST_URL, bfHeaders } from "./_core.js";
import { preflight, send, fail, readRawBody } from "./_http.js";

// Blockfrost proxy — hides the project key server-side. It must be a SINGLE
// top-level function: Vercel (framework: null) doesn't honor the `[...path]`
// catch-all convention, so a nested dynamic route 404s. vercel.json rewrites
//   /bf/:path*  ->  /api/bf?__bf=:path*   (original query is preserved)
// and we reconstruct the blockfrost URL from `__bf` + the remaining query.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const u = new URL(req.url ?? "/api/bf", "http://x");
        const sub = u.searchParams.get("__bf") ?? "";   // e.g. "addresses/addr1.../utxos"
        u.searchParams.delete("__bf");
        const rest = u.searchParams.toString();          // e.g. "count=100&page=1"
        const target = `${BLOCKFROST_URL}/${sub}${rest ? "?" + rest : ""}`;
        const init: RequestInit = { method: req.method ?? "GET", headers: { ...bfHeaders() } };
        if (req.method === "POST") {
            const raw = await readRawBody(req);
            init.body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
            init.headers = { ...bfHeaders(), "content-type": req.headers["content-type"] ?? "application/cbor" };
        }
        const r = await fetch(target, init);
        const buf = new Uint8Array(await r.arrayBuffer());
        send(res, r.status, buf, r.headers.get("content-type") ?? "application/json");
    } catch (e) { fail(res, e); }
}
