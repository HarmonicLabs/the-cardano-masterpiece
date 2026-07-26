// ===========================================================================
//  Frontend chain access — everything a BROWSER needs to build txs itself.
//
//  * chain queries go through the server's same-origin /bf blockfrost proxy
//  * the user's funding/collateral come from the CIP-30 wallet directly
//    (correct even for multi-address wallets, unlike an address-based query)
//  * datum/redeemer encoders mirror offchain/contracts.ts and the contracts
// ===========================================================================
import {
    Address, Value, Hash28, TxBuilder, UTxO, TxOutRef,
    DataConstr, DataB, DataI, DataList, defaultPreprodGenesisInfos,
} from "@harmoniclabs/buildooor";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { sha2_256_sync } from "@harmoniclabs/crypto";
import type { WalletApi } from "@harmoniclabs/use-cardano-wallet";
import config from "../../config.json";
import type { Rect } from "./api.js";

export { config };

export const CANVAS_W = 1008;       // canvas width (row length / stride)
export const CANVAS_H = 1008;       // canvas height (84 leaves x 12 rows)
export const CANVAS = CANVAS_W;     // alias: row stride, used in edit chunk math
export const ROWS_PER_LEAF = 12;
export const N_LEAFS = 84;
export const LOVELACE_PER_PIXEL = 3_000_000n;   // genesis/fallback default (live price read from chain)
export const MIN_LISTING_LOVELACE = 2_000_000n;

/** true if the given wallet address is the protocol owner (payment-cred match,
 * ignoring the staking part) — the owner claims free space for free. */
export const isProtocolOwner = (address: string): boolean => {
    try {
        return Address.fromString(address).paymentCreds.hash.toString()
            === Address.fromString(config.protocolOwnerAddress).paymentCreds.hash.toString();
    } catch {
        return false;
    }
};

// ---- hex (no Buffer in the browser) ---------------------------------------
export const hexToBytes = (h: string): Uint8Array => {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
};
export const bytesToHex = (b: Uint8Array): string =>
    Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const asciiBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---- blockfrost via the same-origin proxy ---------------------------------
// `globalThis.location` resolves in BOTH the window and a WebWorker (the edit
// prebuilder runs this module off-thread), and the worker is same-origin, so
// the /bf proxy is reachable either way.
export const bf = new BlockfrostPluts({
    customBackend: `${globalThis.location.origin}/bf`,
    network: "preprod",
});

let _txb: TxBuilder | undefined;
export async function txBuilder(): Promise<TxBuilder> {
    if (_txb) return _txb;
    _txb = new TxBuilder(await bf.getProtocolParameters(), defaultPreprodGenesisInfos);
    return _txb;
}

export async function utxosAt(address: string): Promise<UTxO[]> {
    try {
        return await bf.addressUtxos(address as `addr_test1${string}`);
    } catch (e) {
        if (String(e).includes("404")) return [];
        throw e;
    }
}

let _refs: { refO: UTxO; refM: UTxO; refK: UTxO } | undefined;
export async function refScripts(): Promise<{ refO: UTxO; refM: UTxO; refK: UTxO }> {
    if (!_refs) {
        const [o, m, k] = await bf.resolveUtxos([
            new TxOutRef({ id: config.ownershipRefScript.txHash, index: config.ownershipRefScript.index }),
            new TxOutRef({ id: config.masterpieceRefScript.txHash, index: config.masterpieceRefScript.index }),
            new TxOutRef({ id: config.marketplaceRefScript.txHash, index: config.marketplaceRefScript.index }),
        ]);
        _refs = { refO: o, refM: m, refK: k };
    }
    return _refs;
}

// ---- wallet funding -------------------------------------------------------
const PROTECTED_REFS = [
    `${config.ownershipRefScript.txHash}#${config.ownershipRefScript.index}`,
    `${config.masterpieceRefScript.txHash}#${config.masterpieceRefScript.index}`,
    `${config.marketplaceRefScript.txHash}#${config.marketplaceRefScript.index}`,
];
type ValueJson = Record<string, Record<string, string | number | bigint>>;
export const lovelacesOf = (u: UTxO): bigint => u.resolved.value.lovelaces;
export const isPureAda = (u: UTxO): boolean =>
    Object.keys(u.resolved.value.toJson() as ValueJson).length === 1;
export const amountOf = (u: UTxO, policyHex: string, nameHex: string): bigint => {
    const j = u.resolved.value.toJson() as ValueJson;
    return BigInt(j[policyHex]?.[nameHex] ?? 0n);
};

/** all wallet utxos, straight from the CIP-30 api */
export async function walletUtxos(api: WalletApi): Promise<UTxO[]> {
    const raw = (await api.getUtxos()) ?? [];
    return raw.map((cbor) => UTxO.fromCbor(cbor));
}

/**
 * Pick the FEWEST wallet utxos that cover `targetLovelace` (+ fee/collateral
 * headroom), largest-ADA first, pure-ADA preferred.
 *
 * buildooor SPENDS EVERY input it is handed (change = inputs − outputs − fee)
 * and does no coin-selection of its own, so handing it the whole wallet bloats
 * the tx — fatal for the ~14 KB leaf-edit tx that is already near the 16384-byte
 * limit. Minimal coverage keeps txs small while still letting buildooor
 * auto-select collateral from these inputs (no separate collateral utxo). Pure-
 * ADA utxos are preferred so token utxos aren't dragged into change, but they
 * are used as fallback, so a wallet whose ada sits in token utxos still works.
 */
/** the pure selection over a known utxo set (also used off-thread) */
export function pickFunding(
    utxos: UTxO[], excludeRefs: string[] = [], targetLovelace: bigint = 0n,
): UTxO[] {
    const usable = utxos.filter((u) =>
        !excludeRefs.includes(u.utxoRef.toString())
        && !PROTECTED_REFS.includes(u.utxoRef.toString())
        && u.resolved.refScript === undefined);
    if (usable.length === 0) throw new Error("wallet has no spendable utxo to fund the transaction");
    const desc = (a: UTxO, b: UTxO) => Number(lovelacesOf(b) - lovelacesOf(a));
    const ordered = [
        ...usable.filter(isPureAda).sort(desc),
        ...usable.filter((u) => !isPureAda(u)).sort(desc),
    ];
    const need = targetLovelace + 5_000_000n;   // fees + collateral headroom
    const picked: UTxO[] = [];
    let sum = 0n;
    for (const u of ordered) {
        picked.push(u);
        sum += lovelacesOf(u);
        if (sum >= need) break;
    }
    return picked;
}

export async function walletFunding(
    api: WalletApi, excludeRefs: string[] = [], targetLovelace: bigint = 0n,
): Promise<UTxO[]> {
    return pickFunding(await walletUtxos(api), excludeRefs, targetLovelace);
}

/** deed utxos held by the wallet, by asset name */
export async function walletDeed(api: WalletApi, name: string): Promise<UTxO> {
    const nameHex = bytesToHex(asciiBytes(name));
    const u = (await walletUtxos(api)).find((x) => amountOf(x, config.ownershipPolicy, nameHex) === 1n);
    if (!u) throw new Error(`this wallet does not hold the deed "${name}"`);
    return u;
}

// ---- rects / datums / redeemers (mirror the contracts) --------------------
export const rectName = (r: Rect): Uint8Array => asciiBytes(`masterpiece-${r.x0}-${r.y0}-${r.x1}-${r.y1}`);
export const rectNameStr = (r: Rect): string => `masterpiece-${r.x0}-${r.y0}-${r.x1}-${r.y1}`;
export const rectData = (r: Rect): DataConstr => new DataConstr(0, [
    new DataI(r.x0), new DataI(r.y0), new DataI(r.x1), new DataI(r.y1),
]);
export const rectArea = (r: Rect): bigint => BigInt((r.x1 - r.x0) * (r.y1 - r.y0));
export const rectValid = (r: Rect): boolean =>
    Number.isInteger(r.x0) && Number.isInteger(r.y0) && Number.isInteger(r.x1) && Number.isInteger(r.y1)
    && 0 <= r.x0 && r.x0 < r.x1 && r.x1 <= CANVAS_W && 0 <= r.y0 && r.y0 < r.y1 && r.y1 <= CANVAS_H;
export const rectContains = (o: Rect, i: Rect): boolean =>
    o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;

export const freeDatum = (r: Rect): DataConstr => new DataConstr(0, [rectData(r)]);
export const leafDatum = (idx: number, chunk: Uint8Array, rawCid: Uint8Array): DataConstr =>
    new DataConstr(1, [new DataI(idx), new DataB(rawCid), new DataB(chunk)]);

export const oClaim = (rect: Rect): DataConstr => new DataConstr(0, [rectData(rect)]);
// Free spend method 1: protocol owner claims free space without paying
export const oOwnerClaim = (rect: Rect): DataConstr => new DataConstr(1, [rectData(rect)]);
// LovelacePerPixel state (datum Constr 1): the owner-set price + its change redeemer
export const PRICE_NFT_NAME = asciiBytes("price-nft");
export const PRICE_NFT_NAME_HEX = bytesToHex(PRICE_NFT_NAME);
export const MIN_LOVELACE_PER_PIXEL = 1_000_000n;
export const lovelacePerPixelDatum = (value: bigint): DataConstr => new DataConstr(1, [new DataI(value)]);
export const oPriceChange = (): DataConstr => new DataConstr(0, []);
export const oMintFree = (): DataConstr => new DataConstr(1, []);
export const oMintCarve = (parent: Rect, target: Rect): DataConstr =>
    new DataConstr(3, [rectData(parent), rectData(target)]); // carve reindexed 4->3 (split removed)
export const mpEdit = (rects: Rect[]): DataConstr =>
    new DataConstr(0, [new DataList(rects.map(rectData))]);

export const listingDatum = (seller: Address, pricePerPixel: bigint): DataConstr =>
    new DataConstr(0, [seller.toData(), new DataI(pricePerPixel)]);
export const requestDatum = (requester: Address, r: Rect): DataConstr =>
    new DataConstr(1, [requester.toData(), rectData(r)]);
export const mBuy = (rect: Rect): DataConstr => new DataConstr(0, [rectData(rect)]);
export const mPartialBuy = (parent: Rect, bought: Rect): DataConstr =>
    new DataConstr(1, [rectData(parent), rectData(bought)]);
export const mListingCancel = (): DataConstr => new DataConstr(2, []);
export const mFill = (): DataConstr => new DataConstr(0, []);
export const mRequestCancel = (): DataConstr => new DataConstr(1, []);

export const txOutRefTag = (ref: TxOutRef): DataConstr => new DataConstr(0, [
    new DataB(hexToBytes(ref.id.toString())),
    new DataI(Number(ref.index)),
]);

export const carveComplements = (parent: Rect, target: Rect): Rect[] => {
    const out: Rect[] = [];
    if (parent.y0 < target.y0) out.push({ x0: parent.x0, y0: parent.y0, x1: parent.x1, y1: target.y0 });
    if (target.y1 < parent.y1) out.push({ x0: parent.x0, y0: target.y1, x1: parent.x1, y1: parent.y1 });
    if (parent.x0 < target.x0) out.push({ x0: parent.x0, y0: target.y0, x1: target.x0, y1: target.y1 });
    if (target.x1 < parent.x1) out.push({ x0: target.x1, y0: target.y0, x1: parent.x1, y1: target.y1 });
    return out;
};

export const tokens = (policyHex: string, entries: [Uint8Array, bigint][]): Value =>
    entries.reduce((v, [name, amt]) =>
        Value.add(v, Value.singleAsset(new Hash28(policyHex), name, amt)), Value.zero);

// ---- CIDv1 raw (sha2_256 from @harmoniclabs/crypto: browser-safe) ---------
export const cidV1Raw = (content: Uint8Array): Uint8Array => {
    const h = new Uint8Array(sha2_256_sync(content));
    const out = new Uint8Array(4 + h.length);
    out.set([0x01, 0x55, 0x12, 0x20]); out.set(h, 4);
    return out;
};

// ---- script-state parsing -------------------------------------------------
export const asConstr = (d: unknown): DataConstr => {
    if (!(d instanceof DataConstr)) throw new Error("expected constr datum");
    return d;
};
export const asBytes = (d: unknown): Uint8Array => {
    if (!(d instanceof DataB)) throw new Error("expected bytes field");
    const b: unknown = d.bytes;
    return b instanceof Uint8Array ? b : (b as { toBuffer(): Uint8Array }).toBuffer();
};
export const asInt = (d: unknown): number => {
    if (!(d instanceof DataI)) throw new Error("expected int field");
    return Number(d.int);
};

export interface FreeNode { rect: Rect; utxo: UTxO; }
export async function freeNodes(): Promise<FreeNode[]> {
    const utxos = await utxosAt(config.ownershipAddress);
    const out: FreeNode[] = [];
    for (const u of utxos) {
        if (amountOf(u, config.ownershipPolicy, "") !== 1n) continue;
        if (!u.resolved.datum) continue;
        try {
            const d = asConstr(u.resolved.datum);
            if (Number(d.constr) !== 0) continue;
            const c = asConstr(d.fields[0]);
            out.push({
                rect: { x0: asInt(c.fields[0]), y0: asInt(c.fields[1]), x1: asInt(c.fields[2]), y1: asInt(c.fields[3]) },
                utxo: u,
            });
        } catch { /* not a free node */ }
    }
    return out;
}

// the price config node: the single utxo holding the price NFT. Its datum
// (LovelacePerPixel, Constr 1) carries the current lovelace-per-pixel. Claims
// reference it; the NFT is what makes it un-counterfeitable.
export interface PriceConfig { utxo: UTxO; pricePerPixel: bigint; }
export async function priceConfig(): Promise<PriceConfig> {
    const utxos = await utxosAt(config.ownershipAddress);
    for (const u of utxos) {
        if (amountOf(u, config.ownershipPolicy, PRICE_NFT_NAME_HEX) !== 1n) continue;
        if (!u.resolved.datum) continue;
        const d = asConstr(u.resolved.datum);
        if (Number(d.constr) !== 1) continue;
        const v = d.fields[0];
        if (!(v instanceof DataI)) continue;
        return { utxo: u, pricePerPixel: v.int };
    }
    throw new Error("price config not found on-chain");
}

export interface LeafInfo { idx: number; chunk: Uint8Array; utxo: UTxO; }
/** the hatched leaf utxo for `leafIdx`, with its current chunk */
export async function leafAt(leafIdx: number): Promise<LeafInfo> {
    const utxos = await utxosAt(config.masterpieceAddress);
    for (const u of utxos) {
        if (!u.resolved.datum) continue;
        try {
            const d = asConstr(u.resolved.datum);
            if (Number(d.constr) !== 1) continue;
            const idx = asInt(d.fields[0]);
            if (idx !== leafIdx) continue;
            return { idx, chunk: asBytes(d.fields[2]), utxo: u };
        } catch { /* not a leaf */ }
    }
    throw new Error(`leaf ${leafIdx} is not hatched yet`);
}

/** a marketplace order utxo by its ref */
export async function marketUtxo(utxoRef: string): Promise<UTxO> {
    const u = (await utxosAt(config.marketplaceAddress)).find((x) => x.utxoRef.toString() === utxoRef);
    if (!u) throw new Error("order not found (already taken or canceled?)");
    return u;
}
