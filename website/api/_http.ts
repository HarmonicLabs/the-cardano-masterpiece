// Response/request helpers shared by the Vercel serverless functions.
// Handlers are typed with Node's http types; Vercel's Node runtime passes
// compatible objects, so no @vercel/node dependency is needed.
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonReplacer } from "./_core.ts";

const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
};

/** true if this was a CORS preflight (already answered) */
export function preflight(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return true;
    }
    return false;
}

/**
 * Send bytes/string. `cacheSeconds` sets a CDN cache window
 * (`s-maxage` + `stale-while-revalidate`) — the serverless replacement for
 * the local server's in-memory cache. 0 = no-store.
 */
export function send(
    res: ServerResponse, code: number, body: Uint8Array | string, type: string, cacheSeconds = 0,
): void {
    res.writeHead(code, {
        "content-type": type,
        "cache-control": cacheSeconds > 0
            ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`
            : "no-store",
        ...CORS,
    });
    res.end(body);
}

export const sendJson = (res: ServerResponse, code: number, obj: unknown, cacheSeconds = 0): void =>
    send(res, code, JSON.stringify(obj, jsonReplacer, 2), "application/json", cacheSeconds);

export const fail = (res: ServerResponse, e: unknown): void => {
    console.error(e);
    sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
};

// Vercel's Node runtime may pre-populate req.body; fall back to the raw
// stream otherwise.
export async function readRawBody(req: IncomingMessage & { body?: unknown }): Promise<Buffer> {
    if (req.body != null) {
        if (Buffer.isBuffer(req.body)) return req.body;
        if (typeof req.body === "string") return Buffer.from(req.body);
        if (req.body instanceof Uint8Array) return Buffer.from(req.body);
        return Buffer.from(JSON.stringify(req.body));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage & { body?: unknown }): Promise<T> {
    if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !(req.body instanceof Uint8Array))
        return req.body as T;
    const raw = (await readRawBody(req)).toString("utf8");
    return JSON.parse(raw || "{}") as T;
}

/** the query string of the request, parsed */
export const query = (req: IncomingMessage): URLSearchParams =>
    new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
