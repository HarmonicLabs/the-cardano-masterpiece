import type { IncomingMessage, ServerResponse } from "node:http";
import { BLOCKFROST_URL, bfHeaders } from "../_core.ts";
import { preflight, send, fail, readRawBody } from "../_http.ts";

// vercel.json rewrites /bf/:path* -> /api/bf/:path*, so req.url here is
// /api/bf/<path>?<query>. Strip the /api/bf prefix to get the blockfrost path.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const [path, qs] = (req.url ?? "").split("?");
        const sub = path.replace(/^\/api\/bf/, "").replace(/^\/bf/, "");
        const target = BLOCKFROST_URL + sub + (qs ? "?" + qs : "");
        const init: RequestInit = { method: req.method ?? "GET", headers: { ...bfHeaders() } };
        if (req.method === "POST") {
            const raw = await readRawBody(req);
            // ArrayBuffer copy — unambiguously a BodyInit
            init.body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
            init.headers = { ...bfHeaders(), "content-type": req.headers["content-type"] ?? "application/cbor" };
        }
        const r = await fetch(target, init);
        const buf = new Uint8Array(await r.arrayBuffer());
        send(res, r.status, buf, r.headers.get("content-type") ?? "application/json");
    } catch (e) { fail(res, e); }
}
