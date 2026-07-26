// ===========================================================================
//  On-chain SVG artwork + CIP-25 metadata for stewardship deed NFTs.
//
//  The SVG is deliberately tiny (~1 KB, ~1.4 KB base64): a carve mints up to
//  5 deeds in one tx, and all their metadata must fit alongside the tx body
//  within the 16 KB limit. Style mirrors the website's gallery theme
//  (charcoal, brass, serif) and shows the plot's coordinates plus a minimap
//  marker of where it sits on the 1008x1008 canvas.
//
//  Pure module: no window/node dependencies (btoa exists in both), safe to
//  import from the browser app AND from server.ts.
// ===========================================================================
import {
    TxMetadata, TxMetadatumMap, TxMetadatumList, TxMetadatumText,
    type TxMetadatum,
} from "@harmoniclabs/buildooor";

export interface DeedRect { x0: number; y0: number; x1: number; y1: number; }

const GOLD = "#c9a86a";
const INK = "#eae7de";

/** the deed artwork: gallery-style plaque with coordinates and a minimap */
export function deedSvg(r: DeedRect): string {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    // minimap: 150x150 canvas box, gold marker at the plot's position
    const S = 150 / 1008, MX = 245, MY = 420;
    const mx = (MX + r.x0 * S).toFixed(1), my = (MY + r.y0 * S).toFixed(1);
    const mw = Math.max(2, w * S).toFixed(1), mh = Math.max(2, h * S).toFixed(1);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">`
        + `<rect width="640" height="640" fill="#0d0d10"/>`
        + `<rect x="14" y="14" width="612" height="612" fill="none" stroke="${GOLD}" stroke-width="2"/>`
        + `<rect x="24" y="24" width="592" height="592" fill="none" stroke="${GOLD}" opacity=".35"/>`
        + `<text x="320" y="180" text-anchor="middle" fill="${INK}" font-family="Georgia,serif" font-size="44">The Cardano</text>`
        + `<text x="320" y="232" text-anchor="middle" fill="${GOLD}" font-family="Georgia,serif" font-size="44">Masterpiece</text>`
        + `<text x="320" y="285" text-anchor="middle" fill="${INK}" opacity=".55" font-family="Georgia,serif" font-size="16" letter-spacing="7">STEWARDSHIP NFT</text>`
        + `<rect x="290" y="308" width="60" height="1" fill="${GOLD}"/>`
        + `<text x="320" y="352" text-anchor="middle" fill="${INK}" font-family="monospace" font-size="24">(${r.x0},${r.y0}) - (${r.x1},${r.y1})</text>`
        + `<text x="320" y="382" text-anchor="middle" fill="${INK}" opacity=".5" font-family="monospace" font-size="15">${w} x ${h} px</text>`
        + `<rect x="${MX}" y="${MY}" width="150" height="150" fill="none" stroke="${INK}" opacity=".3"/>`
        + `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="${GOLD}"/>`
        + `</svg>`;
}

const deedName = (r: DeedRect): string => `masterpiece-${r.x0}-${r.y0}-${r.x1}-${r.y1}`;

/** CIP-25 long strings: arrays of <=64-char chunks */
const chunk64 = (s: string): TxMetadatum => {
    if (s.length <= 64) return new TxMetadatumText(s);
    const parts: TxMetadatumText[] = [];
    for (let i = 0; i < s.length; i += 64) parts.push(new TxMetadatumText(s.slice(i, i + 64)));
    return new TxMetadatumList(parts);
};
const txt = (s: string): TxMetadatumText => new TxMetadatumText(s);

/** CIP-25 (label 721) metadata covering every deed minted by a tx */
export function deedCip25(policyIdHex: string, rects: DeedRect[]): TxMetadata {
    const assets: [TxMetadatumText, TxMetadatum][] = rects.map((r) => [
        txt(deedName(r)),
        new TxMetadatumMap([
            { k: txt("name"), v: chunk64(`Masterpiece plot (${r.x0},${r.y0})-(${r.x1},${r.y1})`) },
            { k: txt("image"), v: chunk64(`data:image/svg+xml;base64,${btoa(deedSvg(r))}`) },
            { k: txt("mediaType"), v: txt("image/svg+xml") },
        ]),
    ]);
    return new TxMetadata({
        721: new TxMetadatumMap([{
            k: txt(policyIdHex),
            v: new TxMetadatumMap(assets.map(([k, v]) => ({ k, v }))),
        }]),
    });
}
