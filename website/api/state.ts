import type { IncomingMessage, ServerResponse } from "node:http";
import { chainState, config, currentPrice } from "./_core.js";
import { preflight, sendJson, fail } from "./_http.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const [s, price] = await Promise.all([chainState(), currentPrice()]);
        sendJson(res, 200, {
            hatchedLeaves: s.leaves.map((l) => l.idx),
            unhatched: s.unhatched,
            committedImageUri: s.committedImageUri,
            fetchedAt: s.fetchedAt,
            network: config.network,
            masterpieceAddress: config.masterpieceAddress,
            masterpiecePolicy: config.masterpiecePolicy,
            stewardshipPolicy: config.stewardshipPolicy,
            pricePerPixelLovelace: price,
        });   // no HTTP cache: the steward-set price stays live (the heavy
              // chainState is still shielded by its own in-memory cache)
    } catch (e) { fail(res, e); }
}
