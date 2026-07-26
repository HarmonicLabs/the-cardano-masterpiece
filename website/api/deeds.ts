import type { IncomingMessage, ServerResponse } from "node:http";
import { deedsRegistry } from "./_core.ts";
import { preflight, sendJson, fail } from "./_http.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try { sendJson(res, 200, await deedsRegistry(), 30); }
    catch (e) { fail(res, e); }
}
