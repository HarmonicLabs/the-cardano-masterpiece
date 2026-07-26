// ===========================================================================
//  Root/commit machinery for the browser — byte-exact mirror of offchain
//  cid.ts + contracts.ts (rootDatum / buildBmpHeader). DOM-free so it runs in
//  the edit prebuilder worker too. Used to build `RootNft.commit` txs that sync
//  an edited leaf's CID into the root's CIP-68 metadata (whole-image IPFS CID).
// ===========================================================================
import { DataConstr, DataB, DataI, DataMap, DataPair, DataList, Hash28, UTxO } from "@harmoniclabs/buildooor";
import { sha2_256_sync } from "@harmoniclabs/crypto";
import {
    config, CANVAS_W, ROWS_PER_LEAF, N_LEAFS, utxosAt, amountOf, asConstr, asBytes, hexToBytes, bytesToHex,
} from "./chain.ts";
import { PALETTE } from "./palette.ts";

const CHUNK_SIZE = CANVAS_W * ROWS_PER_LEAF;   // 12096
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

export const ROOT_REF_NFT_NAME = hexToBytes("000643b06d61737465727069656365"); // (100)masterpiece
export const ROOT_REF_NFT_NAME_HEX = bytesToHex(ROOT_REF_NFT_NAME);
const METADATA_NAME_KEY = ascii("name");
const METADATA_IMAGE_KEY = ascii("image");
const METADATA_MEDIA_TYPE_KEY = ascii("mediaType");
const ROOT_DISPLAY_NAME = ascii("The Cardano Masterpiece");
const MEDIA_TYPE_BMP = ascii("image/bmp");

// ---- CID computation (mirror of offchain/cid.ts) --------------------------
const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(sha2_256_sync(b));
const concat = (...bs: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(bs.reduce((a, b) => a + b.length, 0));
    let o = 0; for (const b of bs) { out.set(b, o); o += b.length; }
    return out;
};
const bytes = (...v: number[]) => Uint8Array.from(v);

function uvarint(n: number): Uint8Array {
    const out: number[] = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b += 128; out.push(b); } while (n > 0);
    return Uint8Array.from(out);
}
const cidV1Raw = (content: Uint8Array): Uint8Array => concat(bytes(0x01, 0x55, 0x12, 0x20), sha256(content));
const pbLink = (childCid: Uint8Array, tsize: number): Uint8Array => {
    const body = concat(bytes(0x0a, 0x24), childCid, bytes(0x12, 0x00, 0x18), uvarint(tsize));
    return concat(bytes(0x12), uvarint(body.length), body);
};
const unixfsFile = (filesize: number, blocksizes: number[]): Uint8Array => {
    let acc = concat(bytes(0x08, 0x02, 0x18), uvarint(filesize));
    for (const bs of blocksizes) acc = concat(acc, bytes(0x20), uvarint(bs));
    return acc;
};
function dagPbFileRoot(childCids: Uint8Array[], tsizes: number[], filesize: number, blocksizes: number[]): Uint8Array {
    let links: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < childCids.length; i++) links = concat(links, pbLink(childCids[i], tsizes[i]));
    const dat = unixfsFile(filesize, blocksizes);
    return concat(links, bytes(0x0a), uvarint(dat.length), dat);
}
const wholeImageCid = (childCids: Uint8Array[], tsizes: number[], filesize: number, blocksizes: number[]): Uint8Array =>
    concat(bytes(0x01, 0x70, 0x12, 0x20), sha256(dagPbFileRoot(childCids, tsizes, filesize, blocksizes)));
function wholeImageCidOf(header: Uint8Array, leafCids: Uint8Array[]): Uint8Array {
    const sizes = [header.length, ...leafCids.map(() => CHUNK_SIZE)];
    const childCids = [cidV1Raw(header), ...leafCids];
    return wholeImageCid(childCids, sizes, header.length + leafCids.length * CHUNK_SIZE, sizes);
}
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Cid(cid: Uint8Array): string {
    let bits = 0, acc = 0, out = "b";
    for (const byte of cid) {
        acc = (acc << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
    return out;
}
export const cidToIpfsUri = (cid: Uint8Array): Uint8Array => ascii("ipfs://" + base32Cid(cid));

// ---- BMP header (mirror of offchain contracts.ts buildBmpHeader) ----------
const W = CANVAS_W, H = N_LEAFS * ROWS_PER_LEAF;   // 1008 x 1008
let _header: Uint8Array | undefined;
function bmpHeader(): Uint8Array {
    if (_header) return _header;
    const buf = new ArrayBuffer(1078);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    u8[0] = 0x42; u8[1] = 0x4d;
    dv.setUint32(2, 1078 + W * H, true);
    dv.setUint32(10, 1078, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, W, true);
    dv.setInt32(22, -H, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 8, true);
    dv.setUint32(30, 0, true);
    dv.setUint32(34, W * H, true);
    dv.setInt32(38, 2835, true);
    dv.setInt32(42, 2835, true);
    dv.setUint32(46, 256, true);
    dv.setUint32(50, 0, true);
    for (let i = 0; i < 256; i++) {
        const o = 54 + i * 4;
        u8[o] = PALETTE[i * 3 + 2]; u8[o + 1] = PALETTE[i * 3 + 1]; u8[o + 2] = PALETTE[i * 3]; u8[o + 3] = 0;
    }
    _header = u8;
    return u8;
}

// ---- root datum ------------------------------------------------------------
export const leafCid = (chunk: Uint8Array): Uint8Array => cidV1Raw(chunk);

/** the RootNft datum for a given full CID list (whole-image CID + CIP-68 image) */
export function rootDatum(leafCids: Uint8Array[]): { rawCid: Uint8Array; uri: Uint8Array; data: DataConstr } {
    const rawCid = wholeImageCidOf(bmpHeader(), leafCids);
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
            new DataConstr(0, [new DataList(leafCids.map((c) => new DataB(c))), new DataB(rawCid)]),
        ]),
    };
}

// RootNft.commit redeemer (state RootNft = 0, method commit = 0): Constr 0 [ refIdx ]
// commit N leaves in one tx: ref-input indices of the committed leaves, ordered
// by ASCENDING leaf index (matches the contract's position walk)
export const mpCommit = (refIdxs: number[]): DataConstr =>
    new DataConstr(0, [new DataList(refIdxs.map((i) => new DataI(i)))]);

// index of `target` in the utxoRef-sorted set — mirrors offchain sortedRefIndex.
// buildooor sorts reference inputs by (txId, index); the commit redeemer points
// at the leaf's position in that sorted set (which also contains the ref script).
export function sortedRefIndex(refs: { id: { toString(): string }; index: number | bigint }[], target: { id: { toString(): string }; index: number | bigint }): number {
    const key = (r: { id: { toString(): string }; index: number | bigint }) => `${r.id.toString()}#${String(r.index).padStart(10, "0")}`;
    const sorted = [...refs].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const t = key(target);
    return sorted.findIndex((r) => key(r) === t);
}

/** the on-chain root utxo + its current leaf-CID list */
export async function fetchRoot(): Promise<{ utxo: UTxO; leafCids: Uint8Array[] }> {
    for (const u of await utxosAt(config.masterpieceAddress)) {
        if (amountOf(u, config.masterpiecePolicy, ROOT_REF_NFT_NAME_HEX) !== 1n || !u.resolved.datum) continue;
        const d = asConstr(u.resolved.datum);
        if (Number(d.constr) !== 0) continue;                   // RootNft
        const extra = asConstr(d.fields[2]);                    // RootState { leafsCids, rawCid }
        const list = extra.fields[0];
        const cids = (list as unknown as { list: unknown[] }).list.map((e) => asBytes(e));
        if (cids.length !== N_LEAFS) throw new Error(`root has ${cids.length} cids, expected ${N_LEAFS}`);
        return { utxo: u, leafCids: cids };
    }
    throw new Error("masterpiece root utxo not found");
}

/** raw token value helper for the root output */
export const rootToken = (): [Uint8Array, bigint][] => [[ROOT_REF_NFT_NAME, 1n]];
export const hash28 = (hex: string) => new Hash28(hex);

/**
 * Leaves whose current on-chain CID is AHEAD of the root (edited but not yet
 * committed). Each needs one `commit` tx to sync it into the root's CIP-68
 * whole-image CID. Returned in leaf-index order, shaped as EditedLeaf.
 */
export async function staleLeaves(): Promise<{ leafIdx: number; newCid: Uint8Array; leafUtxo: UTxO }[]> {
    const utxos = await utxosAt(config.masterpieceAddress);
    let rootCids: Uint8Array[] | undefined;
    const leaves: { idx: number; cid: Uint8Array; utxo: UTxO }[] = [];
    for (const u of utxos) {
        if (!u.resolved.datum) continue;
        let d: DataConstr;
        try { d = asConstr(u.resolved.datum); } catch { continue; }
        if (amountOf(u, config.masterpiecePolicy, ROOT_REF_NFT_NAME_HEX) === 1n && Number(d.constr) === 0) {
            const extra = asConstr(d.fields[2]);
            rootCids = (extra.fields[0] as unknown as { list: unknown[] }).list.map((e) => asBytes(e));
        } else if (amountOf(u, config.masterpiecePolicy, "") === 1n && Number(d.constr) === 1) {
            const idxD = d.fields[0];
            if (!(idxD instanceof DataI)) continue;
            leaves.push({ idx: Number(idxD.int), cid: asBytes(d.fields[1]), utxo: u });
        }
    }
    if (!rootCids) throw new Error("masterpiece root not found");
    const cids = rootCids;
    return leaves
        .filter((l) => l.idx >= 0 && l.idx < N_LEAFS && bytesToHex(l.cid) !== bytesToHex(cids[l.idx]))
        .sort((a, b) => a.idx - b.idx)
        .map((l) => ({ leafIdx: l.idx, newCid: l.cid, leafUtxo: l.utxo }));
}
