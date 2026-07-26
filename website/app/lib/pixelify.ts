// ===========================================================================
//  Image import + pixelification into the canvas' 8-bit color palette
//  (see lib/palette.ts). A Sprite is a small w×h grid of palette indices
//  plus an opacity mask; it can be previewed/dragged on the board (claim
//  page) and later applied as pixel edits (edit page).
// ===========================================================================
import { PALETTE, nearestIndex } from "./palette.ts";

export interface Sprite {
    w: number;
    h: number;
    /** palette index (= gray value) per pixel, row-major */
    pixels: Uint8Array;
    /** true = paint this pixel; false = transparent in the source image */
    opaque: Uint8Array;
}

export interface PlacedSprite extends Sprite {
    x: number;
    y: number;
}

export function loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not load image")); };
        img.src = url;
    });
}

/** downscale + grayscale an image into a sprite `targetW` pixels wide */
export function pixelify(img: HTMLImageElement, targetW: number): Sprite {
    const w = Math.max(1, Math.min(1008, Math.round(targetW)));
    const h = Math.max(1, Math.min(1008, Math.round((img.naturalHeight / img.naturalWidth) * w)));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const pixels = new Uint8Array(w * h);
    const opaque = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        // quantize to the nearest on-chain palette color
        pixels[i] = nearestIndex(data[o], data[o + 1], data[o + 2]);
        opaque[i] = data[o + 3] >= 128 ? 1 : 0;
    }
    return { w, h, pixels, opaque };
}

/** render a sprite onto its own canvas (used for board preview) */
export function spriteToCanvas(s: Sprite): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = s.w; cv.height = s.h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(s.w, s.h);
    for (let i = 0; i < s.pixels.length; i++) {
        const p = s.pixels[i] * 3, o = i * 4;
        img.data[o] = PALETTE[p]; img.data[o + 1] = PALETTE[p + 1]; img.data[o + 2] = PALETTE[p + 2];
        img.data[o + 3] = s.opaque[i] ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
}

// ---- hand-off between pages (claim -> edit) --------------------------------

const STORAGE_KEY = "masterpiece.sprite";

// chunked so large pixel arrays don't blow the call stack via spread
const b64 = (u: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function saveSprite(s: PlacedSprite): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            w: s.w, h: s.h, x: s.x, y: s.y,
            pixels: b64(s.pixels), opaque: b64(s.opaque),
        }));
    } catch { /* storage full/unavailable: preview-only */ }
}

export function loadSavedSprite(): PlacedSprite | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw) as { w: number; h: number; x: number; y: number; pixels: string; opaque: string };
        return { w: j.w, h: j.h, x: j.x, y: j.y, pixels: unb64(j.pixels), opaque: unb64(j.opaque) };
    } catch { return null; }
}

export function clearSavedSprite(): void {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
