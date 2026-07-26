// ===========================================================================
//  Shared LOCAL-DEV request handler for /canvas.bin, /api/*, /bf/*.
//
//  Used by BOTH the standalone dev server (server.ts, `npm start`) and the
//  vite dev middleware (vite.config.ts), so `vite` on :5173 can serve the whole
//  app in ONE process — no separate API server to start (or forget to restart).
//
//  `apiHandler` returns true if it handled the request, false otherwise (so the
//  caller can fall through to static/SPA serving or vite's own middleware).
// ===========================================================================
import type { IncomingMessage, ServerResponse } from "node:http";
import { Tx, TxWitnessSet } from "@harmoniclabs/buildooor";
import {
    config, api, BLOCKFROST_URL, bfHeaders, currentPrice, parseAddress, jsonReplacer, invalidateCache,
    chainState, freeNodes, plotsOf, marketOrders, deedsRegistry,
    buildClaimTxs, buildEditTx, buildEditBatchTxs,
    buildMarketListTx, buildMarketBuyTx, buildMarketPartialBuyTx,
    buildMarketCancelTx, buildMarketRequestTx, buildMarketFillTx,
    type Rect, type PixelEdit,
} from "./_core.ts";

function send(res: ServerResponse, code: number, body: Uint8Array | string, type: string): void {
    res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end(body);
}
const sendJson = (res: ServerResponse, code: number, obj: unknown): void =>
    send(res, code, JSON.stringify(obj, jsonReplacer, 2), "application/json");

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
const hex = (tx: Tx): string => Buffer.from(tx.toCborBytes()).toString("hex");

/** true if this request was one of ours (/canvas.bin, /api/*, /bf/*) */
export async function apiHandler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = (req.url ?? "/").split("?")[0];
    const isOurs = url === "/canvas.bin" || url === "/og.png" || url.startsWith("/api/") || url.startsWith("/bf/");
    if (!isOurs) return false;
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");

    try {
        if (req.method === "OPTIONS") { send(res, 204, "", "text/plain"); return true; }

        // ---- reads
        if (url === "/canvas.bin") {
            const s = await chainState();
            send(res, 200, s.pixels, "application/octet-stream"); return true;
        }
        if (url === "/og.png") {
            const { renderOgPng } = await import("./ogImage.ts");
            const s = await chainState();
            send(res, 200, renderOgPng(s.pixels), "image/png"); return true;
        }
        if (url === "/api/state") {
            const [s, price] = await Promise.all([chainState(), currentPrice()]);
            sendJson(res, 200, {
                hatchedLeaves: s.leaves.map((l) => l.idx),
                unhatched: s.unhatched,
                committedImageUri: s.committedImageUri,
                fetchedAt: s.fetchedAt,
                network: config.network,
                masterpieceAddress: config.masterpieceAddress,
                masterpiecePolicy: config.masterpiecePolicy,
                ownershipPolicy: config.ownershipPolicy,
                pricePerPixelLovelace: price,   // live owner-set price
            });
            return true;
        }
        if (url === "/api/free") {
            const nodes = await freeNodes();
            sendJson(res, 200, nodes.map((n) => ({ rect: n.rect, utxoRef: n.utxo.utxoRef.toString() }))); return true;
        }
        if (url === "/api/plots") {
            const { plots } = await plotsOf(parseAddress(query.get("address") ?? ""));
            sendJson(res, 200, plots); return true;
        }
        if (url === "/api/market") { sendJson(res, 200, await marketOrders()); return true; }
        if (url === "/api/deeds") { sendJson(res, 200, await deedsRegistry()); return true; }
        if (url === "/api/publish" && req.method === "POST") {
            const { publishCommittedImage } = await import("./publish.ts");   // lazy: heavy IPFS deps
            sendJson(res, 200, await publishCommittedImage()); return true;
        }

        // ---- tx builders (kept for itest.ts; the browser normally self-builds)
        if (url === "/api/tx/claim" && req.method === "POST") {
            const b = await readBody(req) as { address: string; rect: Rect };
            const txs = await buildClaimTxs(parseAddress(b.address), b.rect);
            sendJson(res, 200, { txs: txs.map(hex) }); return true;
        }
        if (url === "/api/tx/edit" && req.method === "POST") {
            const b = await readBody(req) as { address: string; leafIdx: number; pixels: PixelEdit[] };
            sendJson(res, 200, { tx: hex(await buildEditTx(parseAddress(b.address), b.leafIdx, b.pixels)) }); return true;
        }
        if (url === "/api/tx/edit-batch" && req.method === "POST") {
            const b = await readBody(req) as { address: string; groups: { leafIdx: number; pixels: PixelEdit[] }[] };
            const txs = await buildEditBatchTxs(parseAddress(b.address), b.groups);
            sendJson(res, 200, { txs: txs.map(hex) }); return true;
        }
        if (url === "/api/tx/market/list" && req.method === "POST") {
            const b = await readBody(req) as { address: string; name: string; pricePerPixelLovelace: string };
            sendJson(res, 200, { tx: hex(await buildMarketListTx(parseAddress(b.address), b.name, BigInt(b.pricePerPixelLovelace))) }); return true;
        }
        if (url === "/api/tx/market/buy" && req.method === "POST") {
            const b = await readBody(req) as { address: string; utxoRef: string };
            sendJson(res, 200, { tx: hex(await buildMarketBuyTx(parseAddress(b.address), b.utxoRef)) }); return true;
        }
        if (url === "/api/tx/market/partialbuy" && req.method === "POST") {
            const b = await readBody(req) as { address: string; utxoRef: string; bought: Rect };
            sendJson(res, 200, { tx: hex(await buildMarketPartialBuyTx(parseAddress(b.address), b.utxoRef, b.bought)) }); return true;
        }
        if (url === "/api/tx/market/cancel" && req.method === "POST") {
            const b = await readBody(req) as { address: string; utxoRef: string };
            sendJson(res, 200, { tx: hex(await buildMarketCancelTx(parseAddress(b.address), b.utxoRef)) }); return true;
        }
        if (url === "/api/tx/market/request" && req.method === "POST") {
            const b = await readBody(req) as { address: string; rect: Rect; offerLovelace: string };
            sendJson(res, 200, { tx: hex(await buildMarketRequestTx(parseAddress(b.address), b.rect, BigInt(b.offerLovelace))) }); return true;
        }
        if (url === "/api/tx/market/fill" && req.method === "POST") {
            const b = await readBody(req) as { address: string; utxoRef: string };
            sendJson(res, 200, { tx: hex(await buildMarketFillTx(parseAddress(b.address), b.utxoRef)) }); return true;
        }
        if (url === "/api/tx/submit" && req.method === "POST") {
            const b = await readBody(req) as { tx: string; witnesses: string };
            const tx = Tx.fromCbor(b.tx);
            const wits = TxWitnessSet.fromCbor(b.witnesses);
            for (const w of wits.vkeyWitnesses ?? []) tx.addVKeyWitness(w);
            const hash = await api.submitTx(tx);
            invalidateCache();
            sendJson(res, 200, { hash: typeof hash === "string" ? hash : tx.hash.toString() }); return true;
        }

        // ---- same-origin blockfrost proxy (the browser queries chain / self-builds)
        if (url.startsWith("/bf/")) {
            const target = BLOCKFROST_URL + url.slice(3)
                + ((req.url ?? "").includes("?") ? "?" + (req.url ?? "").split("?")[1] : "");
            const init: RequestInit = { method: req.method ?? "GET", headers: { ...bfHeaders() } };
            if (req.method === "POST") {
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                init.body = Buffer.concat(chunks);
                init.headers = { ...bfHeaders(), "content-type": req.headers["content-type"] ?? "application/cbor" };
            }
            const r = await fetch(target, init);
            const body = new Uint8Array(await r.arrayBuffer());
            send(res, r.status, body, r.headers.get("content-type") ?? "application/json"); return true;
        }

        // an /api/* we don't recognise
        sendJson(res, 404, { error: `no route for ${req.method} ${url}` });
        return true;
    } catch (e) {
        console.error(e);
        sendJson(res, 500, { error: String((e as Error).message ?? e) });
        return true;
    }
}
