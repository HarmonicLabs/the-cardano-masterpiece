import type { IncomingMessage, ServerResponse } from "node:http";
import { plotsOf, parseAddress } from "./_core.ts";
import { preflight, sendJson, fail, query } from "./_http.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const { plots } = await plotsOf(parseAddress(query(req).get("address") ?? ""));
        sendJson(res, 200, plots);   // per-address, not CDN-cached
    } catch (e) { fail(res, e); }
}
