// ===========================================================================
//  Reconstruct the CURRENT committed masterpiece image from the on-chain leaf
//  UTxOs, build a CAR with the EXACT block layout the contract's CID commits
//  to, and — crucially — only return it if the reconstructed dag-pb ROOT CID
//  matches the on-chain committed image (CIP-68). Node-native (Vercel funcs).
//
//  Byte-exact mirror of offchain/cid.ts + contracts.ts buildBmpHeader, and of
//  app/lib/masterpieceRoot.ts (validated equal to the genesis CID).
// ===========================================================================
import { sha2_256_sync } from "@harmoniclabs/crypto";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { PALETTE } from "../app/lib/palette.js";
import { chainState } from "./_core.js";

// geometry — MUST match src/masterpiece.pebble (mirrored in _core.ts too)
const N_LEAFS = 84, LINE_LENGTH = 1008, ROWS_PER_LEAF = 12;
const CHUNK_SIZE = LINE_LENGTH * ROWS_PER_LEAF;   // 12096
const W = LINE_LENGTH, H = N_LEAFS * ROWS_PER_LEAF; // 1008 x 1008

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
    return concat(links, bytes(0x0a), uvarint(unixfsFile(filesize, blocksizes).length), unixfsFile(filesize, blocksizes));
}
const dagPbCid = (node: Uint8Array): Uint8Array => concat(bytes(0x01, 0x70, 0x12, 0x20), sha256(node));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Cid(cid: Uint8Array): string {
    let b = 0, acc = 0, out = "b";
    for (const x of cid) { acc = (acc << 8) | x; b += 8; while (b >= 5) { out += B32[(acc >> (b - 5)) & 31]; b -= 5; } }
    if (b > 0) out += B32[(acc << (5 - b)) & 31];
    return out;
}

// ---- BMP header (mirror of offchain contracts.ts buildBmpHeader) ----------
let _header: Uint8Array | undefined;
function bmpHeader(): Uint8Array {
    if (_header) return _header;
    const buf = new ArrayBuffer(1078), dv = new DataView(buf), u8 = new Uint8Array(buf);
    u8[0] = 0x42; u8[1] = 0x4d;
    dv.setUint32(2, 1078 + W * H, true); dv.setUint32(10, 1078, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, W, true); dv.setInt32(22, -H, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 8, true); dv.setUint32(30, 0, true);
    dv.setUint32(34, W * H, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
    dv.setUint32(46, 256, true); dv.setUint32(50, 0, true);
    for (let i = 0; i < 256; i++) {
        const o = 54 + i * 4;
        u8[o] = PALETTE[i * 3 + 2]; u8[o + 1] = PALETTE[i * 3 + 1]; u8[o + 2] = PALETTE[i * 3]; u8[o + 3] = 0;
    }
    _header = u8; return u8;
}

async function toCar(rootCid: Uint8Array, blocks: { cid: Uint8Array; data: Uint8Array }[]): Promise<Uint8Array> {
    const { writer, out } = CarWriter.create([CID.decode(rootCid)]);
    const parts: Uint8Array[] = [];
    const collect = (async () => { for await (const c of out) parts.push(c); })();
    for (const b of blocks) await writer.put({ cid: CID.decode(b.cid), bytes: b.data });
    await writer.close();
    await collect;
    return concat(...parts);
}

/** the dag-pb root CID + uri for a full set of leaf chunks (idx order) */
export function imageRoot(leafChunks: Uint8Array[]): { rootCid: Uint8Array; node: Uint8Array; leafCids: Uint8Array[]; uri: string } {
    const header = bmpHeader();
    const leafCids = leafChunks.map((c) => cidV1Raw(c));
    const childCids = [cidV1Raw(header), ...leafCids];
    const sizes = [header.length, ...leafChunks.map(() => CHUNK_SIZE)];
    const filesize = header.length + leafChunks.length * CHUNK_SIZE;
    const node = dagPbFileRoot(childCids, sizes, filesize, sizes);
    const rootCid = dagPbCid(node);
    return { rootCid, node, leafCids, uri: "ipfs://" + base32Cid(rootCid) };
}

export interface CommittedCar { rootCid: Uint8Array; uri: string; car: Uint8Array; cid: string; }

/**
 * Reconstruct the committed image and its CAR — but ONLY if the reconstructed
 * root exactly matches the on-chain committed image. Throws otherwise (e.g.
 * uncommitted leaf edits, or not fully hatched), so pinning never proceeds on
 * content that doesn't reproduce the CIP-68 `image` CID.
 */
export async function buildCommittedCar(): Promise<CommittedCar> {
    const s = await chainState(true);
    if (s.leaves.length !== N_LEAFS)
        throw new Error(`image incomplete: ${s.leaves.length}/${N_LEAFS} leaves hatched`);
    if (!s.committedImageUri) throw new Error("no committed image on-chain yet");

    const leaves = [...s.leaves].sort((a, b) => a.idx - b.idx);
    for (const l of leaves) if (l.chunk.length !== CHUNK_SIZE) throw new Error(`leaf ${l.idx} bad chunk size`);
    const chunks = leaves.map((l) => l.chunk);
    const { rootCid, node, leafCids, uri } = imageRoot(chunks);

    // ---- ROOT-MATCH GUARD: never pin unless it reproduces the on-chain image
    if (uri !== s.committedImageUri)
        throw new Error(`root mismatch — reconstructed ${uri} != on-chain committed ${s.committedImageUri}; refusing to pin (uncommitted edits?)`);

    const header = bmpHeader();
    const blocks = [
        { cid: rootCid, data: node },
        { cid: cidV1Raw(header), data: header },
        ...leaves.map((l, i) => ({ cid: leafCids[i], data: l.chunk })),
    ];
    return { rootCid, uri, car: await toCar(rootCid, blocks), cid: base32Cid(rootCid) };
}
