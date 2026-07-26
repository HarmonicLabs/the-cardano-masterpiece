// ===========================================================================
//  POST /api/publish — pin the CURRENT committed masterpiece image to Filebase
//  (S3-compatible IPFS pinning) and unpin the previous version.
//
//  The CAR is built from the on-chain leaves with the exact block layout the
//  contract commits to, and is uploaded ONLY if its root CID matches the
//  on-chain CIP-68 image (buildCommittedCar's root-match guard). So we can
//  never pin content that doesn't reproduce the committed `image` CID.
//
//  We store it under one fixed object key: importing a new CAR there replaces
//  (and unpins) the previous root automatically — one pin, always current.
//
//  Headless auth via env (S3 access keys from the Filebase dashboard):
//    FILEBASE_KEY / FILEBASE_SECRET / FILEBASE_BUCKET
// ===========================================================================
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildCommittedCar } from "./imageCar.js";
import { putCar, headCid } from "./filebase.js";

// one fixed key: overwriting it replaces + unpins the previous committed image
const OBJECT_KEY = "committed-image.car";

export interface PublishResult { uri: string; cid: string; pinned: boolean; unpinnedPrevious: number; }

/** build (guarded) + pin the committed image; the previous root is replaced */
export async function publishCommittedImage(): Promise<PublishResult> {
    const { car, uri, cid } = await buildCommittedCar();   // throws unless root matches on-chain

    // was a different image pinned before? (overwriting the key unpins it)
    let previous: string | null = null;
    try { previous = await headCid(OBJECT_KEY); } catch { /* first run / transient — ignore */ }

    const pinnedCid = await putCar(OBJECT_KEY, car);
    if (pinnedCid !== cid)
        throw new Error(`Filebase pinned CID ${pinnedCid} != committed ${cid} — refusing (CAR import mismatch)`);

    return { uri, cid, pinned: true, unpinnedPrevious: previous && previous !== cid ? 1 : 0 };
}

// ---- Vercel serverless handler --------------------------------------------
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    // POST (manual / client) or GET (Vercel Cron) both trigger a publish
    if (req.method !== "POST" && req.method !== "GET") { res.writeHead(405, cors); res.end("POST or GET"); return; }
    try {
        const result = await publishCommittedImage();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...cors });
        res.end(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error(e);
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store", ...cors });
        res.end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
    }
}
