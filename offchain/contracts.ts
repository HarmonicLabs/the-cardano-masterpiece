// ===========================================================================
//  Contract loading, parameter application, datum/redeemer encoders.
//  Must stay byte-compatible with src/stewardship.pebble + src/masterpiece.pebble.
// ===========================================================================
import {
    Script, Address, Credential, Hash28, TxOutRef,
    DataConstr, DataI, DataB, DataList, DataMap, DataPair,
    parseUPLC, compileUPLC, UPLCProgram, Application, UPLCConst,
    Cbor, CborBytes,
    type Data, type UPLCTerm,
} from "@harmoniclabs/buildooor";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, hexToBytes } from "./lib.ts";
import { cidV1Raw, wholeImageCidOf, cidToIpfsUri } from "./cid.ts";

export const N_LEAFS = 84;
export const LINE_LENGTH = 1008;   // canvas width (bytes per row)
export const CANVAS_HEIGHT = 1008;
export const ROWS_PER_LEAF = 12;
export const CHUNK_SIZE = LINE_LENGTH * ROWS_PER_LEAF; // 12096
export const LOVELACE_PER_PIXEL = 2_500_000n;      // default/initial price at genesis (mainnet launch)
export const MIN_LOVELACE_PER_PIXEL = 500_000n;    // contract floor (>= 0.5 ADA/px) — MUST match stewardship.pebble

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

export const FREE_TOKEN_NAME = new Uint8Array(0);
export const PRICE_NFT_NAME = ascii("price-nft");      // the unique price-config NFT
export const LEAF_NFT_NAME = new Uint8Array(0);
export const ROOT_REF_NFT_NAME  = hexToBytes("000643b06d61737465727069656365"); // (100)masterpiece
export const ROOT_USER_NFT_NAME = hexToBytes("000de1406d61737465727069656365"); // (222)masterpiece

export const METADATA_NAME_KEY = ascii("name");
export const METADATA_IMAGE_KEY = ascii("image");
export const METADATA_MEDIA_TYPE_KEY = ascii("mediaType");
export const ROOT_DISPLAY_NAME = ascii("The Cardano Masterpiece");
export const MEDIA_TYPE_BMP = ascii("image/bmp");

// ---- 256-color palette ------------------------------------------------------
// 6x6x6 color cube (indices 0..215, channel levels 0,51,..,255; index =
// 36r+6g+b) + 40-step gray ramp (216..255). Index 0 stays black, so the
// genesis all-zero canvas renders as before. Mirrored by the website in
// app/lib/palette.ts — keep in sync.
export const PALETTE_LEVELS = [0, 51, 102, 153, 204, 255] as const;
export function paletteRGB(): Uint8Array {
    const p = new Uint8Array(256 * 3);
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
        const o = (36 * r + 6 * g + b) * 3;
        p[o] = PALETTE_LEVELS[r]; p[o + 1] = PALETTE_LEVELS[g]; p[o + 2] = PALETTE_LEVELS[b];
    }
    for (let i = 0; i < 40; i++) {
        const v = Math.round(i * 255 / 39);
        const o = (216 + i) * 3;
        p[o] = v; p[o + 1] = v; p[o + 2] = v;
    }
    return p;
}

// ---- BMP header (1078 bytes): top-down 8bpp, 256-color palette -------------
export function buildBmpHeader(): Uint8Array {
    const buf = new ArrayBuffer(1078);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    // BITMAPFILEHEADER
    u8[0] = 0x42; u8[1] = 0x4d;                    // "BM"
    dv.setUint32(2, 1078 + 1008 * 1008, true);     // file size
    dv.setUint32(10, 1078, true);                  // pixel data offset
    // BITMAPINFOHEADER
    dv.setUint32(14, 40, true);                    // header size
    dv.setInt32(18, 1008, true);                   // width
    dv.setInt32(22, -1008, true);                  // height NEGATIVE = top-down
    dv.setUint16(26, 1, true);                     // planes
    dv.setUint16(28, 8, true);                     // bpp
    dv.setUint32(30, 0, true);                     // no compression
    dv.setUint32(34, 1008 * 1008, true);           // image size
    dv.setInt32(38, 2835, true);                   // ppm x
    dv.setInt32(42, 2835, true);                   // ppm y
    dv.setUint32(46, 256, true);                   // colors used
    dv.setUint32(50, 0, true);                     // important colors
    // palette: 256 x BGRA from the color-cube + gray-ramp palette
    const pal = paletteRGB();
    for (let i = 0; i < 256; i++) {
        const o = 54 + i * 4;
        u8[o] = pal[i * 3 + 2]; u8[o + 1] = pal[i * 3 + 1]; u8[o + 2] = pal[i * 3]; u8[o + 3] = 0;
    }
    return u8;
}

// ---- rect helpers (mirror src/lib/rect.pebble) -----------------------------
export interface Rect { x0: number; y0: number; x1: number; y1: number; }

export const rectName = (r: Rect): Uint8Array =>
    ascii(`masterpiece-${r.x0}-${r.y0}-${r.x1}-${r.y1}`);
export const rectData = (r: Rect): DataConstr => new DataConstr(0, [
    new DataI(r.x0), new DataI(r.y0), new DataI(r.x1), new DataI(r.y1),
]);
export const rectArea = (r: Rect): bigint => BigInt((r.x1 - r.x0) * (r.y1 - r.y0));

// ---- parameter application -------------------------------------------------
// Pebble's parameter ABI: each `param` is applied as its RUNTIME
// representation — NATIVE constants for scalars (`bytes` -> bytestring,
// `int` -> integer), plain data for data-encoded types (Address, TxOutRef,
// structs). Wrapping a scalar param in Data (`DataB`/`DataI`) miscompiles at
// a distance (see PEBBLE_NOTES.md).
type ParamValue = Uint8Array | bigint | number | Data;

function applyParams(flat: Uint8Array, params: ParamValue[]): Script {
    const prog = parseUPLC(flat, "flat");
    let body: UPLCTerm = prog.body;
    for (const p of params) {
        const c = p instanceof Uint8Array ? UPLCConst.byteString(p)
            : typeof p === "bigint" || typeof p === "number" ? UPLCConst.int(BigInt(p))
            : UPLCConst.data(p);
        body = new Application(body, c);
    }
    const compiled: unknown = compileUPLC(new UPLCProgram(prog.version, body));
    const flatOut = compiled instanceof Uint8Array ? compiled
        : new Uint8Array((compiled as { toBuffer(): Uint8Array }).toBuffer?.() ?? (compiled as Uint8Array));
    return Script.plutusV3(Cbor.encode(new CborBytes(new Uint8Array(flatOut))));
}

export const txOutRefData = (ref: TxOutRef): DataConstr => new DataConstr(0, [
    new DataB(hexToBytes(ref.id.toString())),
    new DataI(Number(ref.index)),
]);

const flatOf = (name: string): Uint8Array =>
    new Uint8Array(readFileSync(join(ROOT, "out", name, "out.flat")));

export interface ContractBundle {
    script: Script;
    hash: Script["hash"];
    policyHex: string;
    address: Address;
}

function bundle(script: Script): ContractBundle {
    return {
        script,
        hash: script.hash,
        policyHex: script.hash.toString(),
        address: Address.testnet(Credential.script(script.hash)),
    };
}

// stewardship params: [ protocolSteward: Address, genesisUtxo: TxOutRef ]
export function stewardshipContract(protocolStewardAddress: Address, genesisRef: TxOutRef): ContractBundle {
    return bundle(applyParams(flatOf("stewardship"), [
        protocolStewardAddress.toData(),
        txOutRefData(genesisRef),
    ]));
}

// masterpiece params: [ stewardshipContractHash: bytes, genesisUtxo: TxOutRef, bmpHeader: bytes ]
export function masterpieceContract(
    stewardshipHashBytes: Uint8Array, genesisRef: TxOutRef, bmpHeader: Uint8Array
): ContractBundle {
    return bundle(applyParams(flatOf("masterpiece"), [
        stewardshipHashBytes,      // bytes param -> native bytestring
        txOutRefData(genesisRef),
        bmpHeader,               // bytes param -> native bytestring
    ]));
}

// ---- masterpiece datums ----------------------------------------------------
// MasterpieceDatum: RootNft = Constr 0 [ metadata(Map), version(I), extra ]
//                   LeafNode = Constr 1 [ idx, rawCid, chunk ]
//                   Nursery  = Constr 2 [ nextIdx ]
// RootState (extra) = Constr 0 [ leafsCids(List<B>), rawCid(B) ]

export interface RootDatum {
    rawCid: Uint8Array;
    uri: Uint8Array;
    data: DataConstr;
}

export function rootDatum(leafCids: Uint8Array[], bmpHeader: Uint8Array): RootDatum {
    const rawCid = wholeImageCidOf(bmpHeader, leafCids, CHUNK_SIZE);
    const uri = cidToIpfsUri(rawCid);
    return {
        rawCid, uri,
        data: new DataConstr(0, [
            new DataMap([
                new DataPair(new DataB(METADATA_NAME_KEY), new DataB(ROOT_DISPLAY_NAME)),
                new DataPair(new DataB(METADATA_IMAGE_KEY), new DataB(uri)),
                new DataPair(new DataB(METADATA_MEDIA_TYPE_KEY), new DataB(MEDIA_TYPE_BMP)),
            ]),
            new DataI(1),
            new DataConstr(0, [
                new DataList(leafCids.map((c) => new DataB(c))),
                new DataB(rawCid),
            ]),
        ]),
    };
}

export const leafDatum = (idx: number, chunk: Uint8Array): DataConstr => new DataConstr(1, [
    new DataI(idx),
    new DataB(cidV1Raw(chunk)),
    new DataB(chunk),
]);

export const nurseryDatum = (nextIdx: number): DataConstr =>
    new DataConstr(2, [new DataI(nextIdx)]);

export const initialChunk = (): Uint8Array => new Uint8Array(CHUNK_SIZE).fill(255);

// ---- stewardship datums ------------------------------------------------------
// Free state datum: the state ABI wraps the record (Constr 0 [ coords ]) —
// see PEBBLE_BUGS.md BUG 17 (dummy second state forces explicit encoding)
export const freeDatum = (r: Rect): DataConstr => new DataConstr(0, [rectData(r)]);
// LovelacePerPixel state datum (Constr 1): the current price, in lovelace/pixel
export const lovelacePerPixelDatum = (value: bigint): DataConstr =>
    new DataConstr(1, [new DataI(value)]);

// ---- redeemers -------------------------------------------------------------
// mint methods dispatch by declaration order; spend methods per state
// (single method per state => Constr 0 [ args ])

// masterpiece
export const mpMintInit = (genesisUtxoIdx: number): DataConstr =>
    new DataConstr(0, [new DataI(genesisUtxoIdx)]);
// commit N leaves in one tx: ref-input indices of the committed leaves,
// ordered by ASCENDING leaf index
export const mpCommit = (refIdxs: number[]): DataConstr =>
    new DataConstr(0, [new DataList(refIdxs.map((i) => new DataI(i)))]);
export const mpEdit = (rects: Rect[]): DataConstr =>
    new DataConstr(0, [new DataList(rects.map(rectData))]);
export const mpHatch = (): DataConstr => new DataConstr(0, []);

// stewardship mint methods (declaration order): init=0, free=1, merge=2,
// carve=3 (`split` removed — it was the 1-complement case of carve).
// Free spend: claim=0(coords), stewardClaim=1(coords)
export const oMintInit = (genesisUtxoIdx: number): DataConstr =>
    new DataConstr(0, [new DataI(genesisUtxoIdx)]);
export const oMintFree = (): DataConstr => new DataConstr(1, []);
export const oMintMerge = (a: Rect, b: Rect): DataConstr =>
    new DataConstr(2, [rectData(a), rectData(b)]);
export const oMintCarve = (parent: Rect, target: Rect): DataConstr =>
    new DataConstr(3, [rectData(parent), rectData(target)]);

// guillotine complements of `target` in `parent`, in the validator's fixed
// order (top, bottom, left, right) — mirrors stewardship `carve` / `Free.claim`
export const carveComplements = (parent: Rect, target: Rect): Rect[] => {
    const out: Rect[] = [];
    if (parent.y0 < target.y0) out.push({ x0: parent.x0, y0: parent.y0, x1: parent.x1, y1: target.y0 });
    if (target.y1 < parent.y1) out.push({ x0: parent.x0, y0: target.y1, x1: parent.x1, y1: parent.y1 });
    if (parent.x0 < target.x0) out.push({ x0: parent.x0, y0: target.y0, x1: target.x0, y1: target.y1 });
    if (target.x1 < parent.x1) out.push({ x0: target.x1, y0: target.y0, x1: parent.x1, y1: target.y1 });
    return out;
};
// Free spend methods (declaration order): claim=0, stewardClaim=1
export const oClaim = (rect: Rect): DataConstr =>
    new DataConstr(0, [rectData(rect)]);
export const oStewardClaim = (rect: Rect): DataConstr =>
    new DataConstr(1, [rectData(rect)]);
// LovelacePerPixel spend: change=0 (no args; new price read from the output)
export const oPriceChange = (): DataConstr => new DataConstr(0, []);

// ---- lock ------------------------------------------------------------------
// no params; utxos at this address are permanently unspendable — the home of
// the protocol's reference-script deployments
export function lockContract(): ContractBundle {
    return bundle(applyParams(flatOf("lock"), []));
}
// single-state ABI: wrapped record (Constr 0 [ fields ])
export const lockedDatum = (): DataConstr => new DataConstr(0, [new DataI(0)]);

// ---- marketplace -----------------------------------------------------------
// params: [ stewardshipPolicy: bytes ]
export function marketplaceContract(stewardshipPolicy: Uint8Array): ContractBundle {
    return bundle(applyParams(flatOf("marketplace"), [stewardshipPolicy]));
}

// datums (state declaration order): Listing = Constr 0 [ seller, pricePerPixel ],
// Request = Constr 1 [ requester, coords ]
export const listingDatum = (seller: Address, pricePerPixelLovelace: bigint): DataConstr =>
    new DataConstr(0, [seller.toData(), new DataI(pricePerPixelLovelace)]);
export const requestDatum = (requester: Address, r: Rect): DataConstr =>
    new DataConstr(1, [requester.toData(), rectData(r)]);

// spend redeemers per state: Listing buy=0(rect) partialBuy=1(parent,bought)
// cancel=2; Request fill=0 cancel=1; bare fallback = 0
export const mBuy = (rect: Rect): DataConstr => new DataConstr(0, [rectData(rect)]);
export const mPartialBuy = (parent: Rect, bought: Rect): DataConstr =>
    new DataConstr(1, [rectData(parent), rectData(bought)]);
export const mListingCancel = (): DataConstr => new DataConstr(2, []);
export const mFill = (): DataConstr => new DataConstr(0, []);
export const mRequestCancel = (): DataConstr => new DataConstr(1, []);
export const mRecover = (): DataConstr => new DataConstr(0, []);
