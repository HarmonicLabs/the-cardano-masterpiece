import type { IncomingMessage, ServerResponse } from "node:http";
import { chainState } from "./_core.js";
import { preflight, send, fail } from "./_http.js";

// served at /canvas.bin via a rewrite in vercel.json
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const s = await chainState();
        send(res, 200, s.pixels, "application/octet-stream", 15);
    } catch (e) { fail(res, e); }
}
