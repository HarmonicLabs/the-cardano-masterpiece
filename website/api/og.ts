import type { IncomingMessage, ServerResponse } from "node:http";
import { chainState } from "./_core.ts";
import { renderOgPng } from "./ogImage.ts";
import { preflight, send, fail } from "./_http.ts";

// served at /og.png via a rewrite in vercel.json — the live collective canvas
// as a social-preview image (Open Graph / Twitter card). Cached 5 min at the
// CDN; crawlers cache it further, so the shared preview reflects a recent
// snapshot of the canvas.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (preflight(req, res)) return;
    try {
        const s = await chainState();
        send(res, 200, renderOgPng(s.pixels), "image/png", 300);
    } catch (e) { fail(res, e); }
}
