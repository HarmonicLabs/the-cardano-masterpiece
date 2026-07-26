import type { IncomingMessage, ServerResponse } from "node:http";
import { Tx, TxWitnessSet, api, invalidateCache } from "../_core.js";
import { preflight, sendJson, fail, readJson } from "../_http.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const body = await readJson<{ tx: string; witnesses: string }>(req);
        const tx = Tx.fromCbor(body.tx);
        const wits = TxWitnessSet.fromCbor(body.witnesses);
        for (const w of wits.vkeyWitnesses ?? []) tx.addVKeyWitness(w);
        const hash = await api.submitTx(tx);
        invalidateCache();
        sendJson(res, 200, { hash: typeof hash === "string" ? hash : tx.hash.toString() });
    } catch (e) { fail(res, e); }
}
