// ===========================================================================
//  The on-chain 256-color palette — MUST mirror offchain/contracts.ts
//  (paletteRGB / buildBmpHeader): 6x6x6 color cube (indices 0..215, channel
//  levels 0,51,..,255, index = 36r+6g+b) + 40-step gray ramp (216..255).
// ===========================================================================

const LEVELS = [0, 51, 102, 153, 204, 255];

function buildPalette(): Uint8Array {
    const p = new Uint8Array(256 * 3);
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
        const o = (36 * r + 6 * g + b) * 3;
        p[o] = LEVELS[r]; p[o + 1] = LEVELS[g]; p[o + 2] = LEVELS[b];
    }
    for (let i = 0; i < 40; i++) {
        const v = Math.round(i * 255 / 39);
        const o = (216 + i) * 3;
        p[o] = v; p[o + 1] = v; p[o + 2] = v;
    }
    return p;
}

/** 256 * [r, g, b] */
export const PALETTE = buildPalette();

const dist2 = (i: number, r: number, g: number, b: number): number => {
    const o = i * 3;
    const dr = PALETTE[o] - r, dg = PALETTE[o + 1] - g, db = PALETTE[o + 2] - b;
    return dr * dr + dg * dg + db * db;
};

/** nearest palette index for an RGB color (exact for this palette shape:
 *  best cube entry vs best gray-ramp entry, whichever is closer) */
export function nearestIndex(r: number, g: number, b: number): number {
    const q = (v: number): number => Math.min(5, Math.max(0, Math.round(v / 51)));
    const cube = 36 * q(r) + 6 * q(g) + q(b);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const gray = 216 + Math.min(39, Math.max(0, Math.round(y * 39 / 255)));
    return dist2(cube, r, g, b) <= dist2(gray, r, g, b) ? cube : gray;
}

/** palette index -> "#rrggbb" (color pickers, swatches) */
export function indexToHex(i: number): string {
    const o = i * 3;
    const h = (v: number): string => v.toString(16).padStart(2, "0");
    return `#${h(PALETTE[o])}${h(PALETTE[o + 1])}${h(PALETTE[o + 2])}`;
}

/** "#rrggbb" -> nearest palette index */
export function hexToIndex(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    return nearestIndex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

/** render palette-index pixels into an ImageData buffer (RGBA) */
export function indicesToImageData(dst: Uint8ClampedArray, indices: Uint8Array): void {
    for (let i = 0; i < indices.length; i++) {
        const p = indices[i] * 3, o = i * 4;
        dst[o] = PALETTE[p]; dst[o + 1] = PALETTE[p + 1]; dst[o + 2] = PALETTE[p + 2];
        dst[o + 3] = 255;
    }
}
