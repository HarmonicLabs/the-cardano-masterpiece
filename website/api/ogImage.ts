// ===========================================================================
//  Social-preview (Open Graph / Twitter card) image renderer.
//
//  Turns the CURRENT collective canvas (1008x1008 palette indices, as served
//  at /canvas.bin) into a PNG that X/Twitter, Facebook, Discord, etc. show
//  when the site link is shared. Those crawlers do NOT run JS and only accept
//  real image formats, so this must be produced server-side.
//
//  We emit an 8-bit INDEXED-color PNG straight from the palette indices (the
//  same 256-color palette the canvas is drawn with) — no RGB expansion, tiny
//  after deflate — letterboxed to ~1.91:1 so the whole SQUARE canvas is
//  visible (centered) inside a `summary_large_image` card instead of being
//  center-cropped.
// ===========================================================================
import { deflateSync } from "node:zlib";
import { PALETTE } from "../app/lib/palette.ts";

const SRC = 1008;                    // source canvas is SRC x SRC palette indices
export const OG_W = 1926;            // ~1.91:1 landscape target (X card ratio)
export const OG_H = 1008;
const X_OFF = (OG_W - SRC) >> 1;     // 459 — canvas centered, black side bars
const BG_INDEX = 0;                  // palette index 0 = black (letterbox bars)

// --- CRC32 (self-contained; not every Node runtime exposes zlib.crc32) ------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
    const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** encode width*height 8-bit palette indices as an indexed-color PNG */
function indexedPng(width: number, height: number, indices: Uint8Array): Buffer {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 3;  // color type 3 = palette/indexed
    // ihdr[10..12] compression/filter/interlace = 0 (already zeroed)

    // scanlines: a leading filter byte (0 = none) + one index byte per pixel
    const stride = width + 1;
    const raw = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++)
        raw.set(indices.subarray(y * width, y * width + width), y * stride + 1);
    const idat = deflateSync(raw, { level: 9 });

    return Buffer.concat([
        sig,
        pngChunk("IHDR", ihdr),
        pngChunk("PLTE", PALETTE),            // 256 * [r,g,b]
        pngChunk("IDAT", idat),
        pngChunk("IEND", new Uint8Array(0)),
    ]);
}

/** current canvas (SRC*SRC indices) -> letterboxed OG PNG bytes */
export function renderOgPng(pixels: Uint8Array): Buffer {
    const buf = new Uint8Array(OG_W * OG_H).fill(BG_INDEX);
    for (let y = 0; y < SRC; y++)
        buf.set(pixels.subarray(y * SRC, y * SRC + SRC), y * OG_W + X_OFF);
    return indexedPng(OG_W, OG_H, buf);
}
