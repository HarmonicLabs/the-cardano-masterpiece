import type { IncomingMessage, ServerResponse } from "node:http";
import { freeNodes } from "./_core.ts";
import { preflight, sendJson, fail } from "./_http.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const nodes = await freeNodes();
        sendJson(res, 200, nodes.map((n) => ({ rect: n.rect, utxoRef: n.utxo.utxoRef.toString() })), 15);
    } catch (e) { fail(res, e); }
}
