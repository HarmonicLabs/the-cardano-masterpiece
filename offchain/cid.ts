// ===========================================================================
//  Off-chain mirror of src/lib/ipfs.pebble — byte-exact CID computation.
//  (No IPFS uploading here: we only compute the CIDs/URIs the validators
//  recompute on-chain, to build matching datums.)
// ===========================================================================
import { createHash } from "node:crypto";

export const sha256 = (b: Uint8Array): Uint8Array =>
    new Uint8Array(createHash("sha256").update(b).digest());

export const concat = (...bs: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const total = bs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const b of bs) { out.set(b, o); o += b.length; }
    return out;
};

const bytes = (...vals: number[]) => Uint8Array.from(vals);

// LEB128 unsigned varint
export function uvarint(n: number): Uint8Array {
    const out: number[] = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b += 128;
        out.push(b);
    } while (n > 0);
    return Uint8Array.from(out);
}

// CIDv1 raw (leaf): 0x01 0x55 0x12 0x20 || sha256(content)
export const cidV1Raw = (content: Uint8Array): Uint8Array =>
    concat(bytes(0x01, 0x55, 0x12, 0x20), sha256(content));

// one PBLink: 12 <len> | 0a 24 <36-byte cid> | 12 00 | 18 <varint tsize>
export function pbLink(childCid: Uint8Array, tsize: number): Uint8Array {
    const body = concat(bytes(0x0a, 0x24), childCid, bytes(0x12, 0x00, 0x18), uvarint(tsize));
    return concat(bytes(0x12), uvarint(body.length), body);
}

// UnixFS Data for a File: 08 02 | 18 <varint filesize> | { 20 <varint bs> }*
export function unixfsFile(filesize: number, blocksizes: number[]): Uint8Array {
    let acc = concat(bytes(0x08, 0x02, 0x18), uvarint(filesize));
    for (const bs of blocksizes) acc = concat(acc, bytes(0x20), uvarint(bs));
    return acc;
}

// dag-pb root node: links (field 2) first, then Data (field 1)
export function dagPbFileRoot(
    childCids: Uint8Array[], tsizes: number[], filesize: number, blocksizes: number[]
): Uint8Array {
    let links: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < childCids.length; i++) links = concat(links, pbLink(childCids[i], tsizes[i]));
    const dat = unixfsFile(filesize, blocksizes);
    return concat(links, bytes(0x0a), uvarint(dat.length), dat);
}

// whole-image CIDv1 (dag-pb): 0x01 0x70 0x12 0x20 || sha256(root node)
export function wholeImageCid(
    childCids: Uint8Array[], tsizes: number[], filesize: number, blocksizes: number[]
): Uint8Array {
    return concat(bytes(0x01, 0x70, 0x12, 0x20), sha256(dagPbFileRoot(childCids, tsizes, filesize, blocksizes)));
}

// mirror of masterpiece.pebble's wholeImageCidOf: header + N leaf chunks
export function wholeImageCidOf(
    header: Uint8Array, leafCids: Uint8Array[], chunkSize = 14336
): Uint8Array {
    const sizes = [header.length, ...leafCids.map(() => chunkSize)];
    const childCids = [cidV1Raw(header), ...leafCids];
    const filesize = header.length + leafCids.length * chunkSize;
    return wholeImageCid(childCids, sizes, filesize, sizes);
}

// base32 (rfc4648 lowercase, no padding) with multibase prefix 'b'
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function base32Cid(cid: Uint8Array /* 36 bytes */): string {
    let bits = 0, acc = 0, out = "b";
    for (const byte of cid) {
        acc = (acc << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
    return out;
}

export const cidToIpfsUri = (cid: Uint8Array): Uint8Array =>
    new TextEncoder().encode("ipfs://" + base32Cid(cid));
