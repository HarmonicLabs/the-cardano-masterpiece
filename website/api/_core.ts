// ===========================================================================
//  The Cardano Masterpiece — API + static server.
//
//  Everything is read from and written to the CHAIN (via Blockfrost as an
//  indexer/submitter) — IPFS is never touched.
//
//    GET  /                    the app (dist/ build; `npm run dev` proxies here)
//    GET  /canvas.bin          1024*1024 palette indices, straight from leaf UTxOs
//    GET  /api/state           canvas metadata
//    GET  /api/free            unclaimed rectangles (stewardship Free nodes)
//    GET  /api/plots?address=  plots owned by an address (deed NFTs)
//    POST /api/tx/claim        { address, rect }           -> { txs } unsigned cbor,
//                              one tx per intersected Free node, submit in order
//    POST /api/tx/edit         { address, leafIdx, pixels } -> { tx } unsigned cbor
//    POST /api/tx/submit       { tx, witnesses }           -> { hash }
// ===========================================================================
// Shared server-side logic — chain reads, datum parsing, tx builders,
// blockfrost submit. Used by the local dev server (server.ts) AND the Vercel
// serverless functions (api/*). No http/static concerns live here.
import "./_env.js";   // MUST be first: loads .env.local into process.env for local dev
import {
    Address, Value, Hash28, Tx, TxBuilder, TxWitnessSet, UTxO, TxOutRef,
    DataConstr, DataB, DataI, DataList, defaultPreprodGenesisInfos, defaultMainnetGenesisInfos,
    type Data, type ITxBuildArgs,
} from "@harmoniclabs/buildooor";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { readFileSync } from "node:fs";
import { deedCip25 } from "../app/lib/deedImage.js";
// config.json is loaded via fs (not an ESM `import … from "*.json"`) so the
// serverless function — compiled per-file to native ESM by Vercel — needs no
// JSON import attribute; @vercel/nft traces this and bundles the file.
const configJson = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));

export { Tx, TxWitnessSet };

interface Config {
    network: string;
    masterpiecePolicy: string;
    masterpieceAddress: string;
    stewardshipPolicy: string;
    stewardshipAddress: string;
    protocolStewardAddress: string;
    marketplacePolicy: string;
    marketplaceAddress: string;
    marketplaceRefScript: { txHash: string; index: number };
    stewardshipRefScript: { txHash: string; index: number };
    masterpieceRefScript: { txHash: string; index: number };
    port: number;
}
export const config: Config = configJson as Config;

const N_LEAFS = 84;
const LINE_LENGTH = 1008;        // canvas width (row stride)
const CANVAS_HEIGHT = 1008;      // 84 leaves x 12 rows
const CHUNK_SIZE = 12096;        // 12 rows x 1008
const ROWS_PER_LEAF = 12;
const IS_MAINNET = config.network === "mainnet";
export const LOVELACE_PER_PIXEL = 2_500_000n;   // genesis/fallback default (live price read from chain)
const ROOT_REF_NFT_NAME_HEX = "000643b06d61737465727069656365"; // (100)masterpiece
const EMPTY_NAME = new Uint8Array(0);

// ---- Blockfrost access: SERVER-SIDE ONLY (never bundled into the SPA) ------
// The browser queries the chain through the same-origin /bf proxy, so the
// Blockfrost base URL and any project-id key live in env vars here, not in the
// public config.json. Precedence: BLOCKFROST_URL, else blockfrost.io when a
// BLOCKFROST_PROJECT_ID key is given, else the public preprod proxy default.
const BF_NETWORK = (config.network || "preprod") as "mainnet" | "preview" | "preprod";
export const BF_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
export const BLOCKFROST_URL = process.env.BLOCKFROST_URL
    ?? (BF_PROJECT_ID ? `https://cardano-${BF_NETWORK}.blockfrost.io/api/v0` : "https://blockfrost-preprod.onchainapps.io");
/** auth header for the raw fetch + the /bf proxy (empty for a keyless proxy) */
export const bfHeaders = (): Record<string, string> => BF_PROJECT_ID ? { project: BF_PROJECT_ID } : {};

export const api = new BlockfrostPluts(
    BF_PROJECT_ID
        ? { projectId: BF_PROJECT_ID, network: BF_NETWORK }
        : { customBackend: BLOCKFROST_URL, network: BF_NETWORK },
);

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---- shared chain helpers -------------------------------------------------

async function utxosAt(address: string): Promise<UTxO[]> {
    try {
        return await api.addressUtxos(address as `addr_test1${string}`);
    } catch (e) {
        if (String(e).includes("404")) return [];
        throw e;
    }
}

type ValueJson = Record<string, Record<string, string | number | bigint>>;
const amountOf = (u: UTxO, policyHex: string, nameHex: string): bigint => {
    const j = u.resolved.value.toJson() as ValueJson;
    return BigInt(j[policyHex]?.[nameHex] ?? 0n);
};
const lovelacesOf = (u: UTxO): bigint => u.resolved.value.lovelaces;
const isPureAda = (u: UTxO): boolean =>
    Object.keys(u.resolved.value.toJson() as ValueJson).length === 1;

function asConstr(d: unknown): DataConstr {
    if (!(d instanceof DataConstr)) throw new Error("expected constr datum");
    return d;
}
const asBytes = (d: unknown): Uint8Array => {
    if (!(d instanceof DataB)) throw new Error("expected bytes field");
    const b: unknown = d.bytes;
    return b instanceof Uint8Array ? b : (b as { toBuffer(): Uint8Array }).toBuffer();
};
const asInt = (d: unknown): number => {
    if (!(d instanceof DataI)) throw new Error("expected int field");
    return Number(d.int);
};

// the steward-set price, read from the NFT-validated LovelacePerPixel config node
const PRICE_NFT_NAME_HEX = Buffer.from("price-nft").toString("hex");
export async function currentPrice(): Promise<bigint> {
    for (const u of await utxosAt(config.stewardshipAddress)) {
        if (amountOf(u, config.stewardshipPolicy, PRICE_NFT_NAME_HEX) !== 1n || !u.resolved.datum) continue;
        try {
            const d = asConstr(u.resolved.datum);
            if (Number(d.constr) === 1 && d.fields[0] instanceof DataI) return d.fields[0].int;
        } catch { /* not the config node */ }
    }
    return LOVELACE_PER_PIXEL;   // fallback to the genesis default
}

// accepts bech32 (addr_test1...) or CIP-30 hex address bytes
export function parseAddress(s: string): Address {
    if (s.startsWith("addr")) return Address.fromString(s);
    return Address.fromBytes(new Uint8Array(Buffer.from(s, "hex")));
}

let _txb: TxBuilder | undefined;
async function txBuilder(): Promise<TxBuilder> {
    if (_txb) return _txb;
    _txb = new TxBuilder(await api.getProtocolParameters(), IS_MAINNET ? defaultMainnetGenesisInfos : defaultPreprodGenesisInfos);
    return _txb;
}

let _refO: UTxO | undefined, _refM: UTxO | undefined, _refK: UTxO | undefined;
async function refScripts(): Promise<{ refO: UTxO; refM: UTxO; refK: UTxO }> {
    if (!_refO || !_refM || !_refK) {
        const [o, m, k] = await api.resolveUtxos([
            new TxOutRef({ id: config.stewardshipRefScript.txHash, index: config.stewardshipRefScript.index }),
            new TxOutRef({ id: config.masterpieceRefScript.txHash, index: config.masterpieceRefScript.index }),
            new TxOutRef({ id: config.marketplaceRefScript.txHash, index: config.marketplaceRefScript.index }),
        ]);
        _refO = o; _refM = m; _refK = k;
    }
    return { refO: _refO!, refM: _refM!, refK: _refK! };
}

// ---- rects / datums / redeemers (mirror offchain/contracts.ts) ------------

export interface Rect { x0: number; y0: number; x1: number; y1: number; }

const rectName = (r: Rect): Uint8Array => ascii(`masterpiece-${r.x0}-${r.y0}-${r.x1}-${r.y1}`);
const rectData = (r: Rect): DataConstr => new DataConstr(0, [
    new DataI(r.x0), new DataI(r.y0), new DataI(r.x1), new DataI(r.y1),
]);
const rectArea = (r: Rect): bigint => BigInt((r.x1 - r.x0) * (r.y1 - r.y0));
const rectValid = (r: Rect): boolean =>
    Number.isInteger(r.x0) && Number.isInteger(r.y0) && Number.isInteger(r.x1) && Number.isInteger(r.y1)
    && 0 <= r.x0 && r.x0 < r.x1 && r.x1 <= LINE_LENGTH && 0 <= r.y0 && r.y0 < r.y1 && r.y1 <= CANVAS_HEIGHT;
const freeDatum = (r: Rect): DataConstr => new DataConstr(0, [rectData(r)]);
const leafDatum = (idx: number, chunk: Uint8Array, rawCid: Uint8Array): DataConstr =>
    new DataConstr(1, [new DataI(idx), new DataB(rawCid), new DataB(chunk)]);

const oClaim = (rect: Rect): DataConstr => new DataConstr(0, [rectData(rect)]);
const oMintFree = (): DataConstr => new DataConstr(1, []);
const oMintCarve = (parent: Rect, target: Rect): DataConstr =>
    new DataConstr(3, [rectData(parent), rectData(target)]); // carve reindexed 4->3 (split removed)
const mpEdit = (rects: Rect[]): DataConstr =>
    new DataConstr(0, [new DataList(rects.map(rectData))]);

// marketplace datums (Listing = Constr 0, Request = Constr 1) and spend
// redeemers (Listing: buy=0(rect) partialBuy=1(parent,bought) cancel=2;
// Request: fill=0 cancel=1)
const listingDatum = (seller: Address, pricePerPixel: bigint): DataConstr =>
    new DataConstr(0, [seller.toData(), new DataI(pricePerPixel)]);
const requestDatum = (requester: Address, r: Rect): DataConstr =>
    new DataConstr(1, [requester.toData(), rectData(r)]);
const mBuy = (rect: Rect): DataConstr => new DataConstr(0, [rectData(rect)]);
const mPartialBuy = (parent: Rect, bought: Rect): DataConstr =>
    new DataConstr(1, [rectData(parent), rectData(bought)]);
const mListingCancel = (): DataConstr => new DataConstr(2, []);
const mFill = (): DataConstr => new DataConstr(0, []);
const mRequestCancel = (): DataConstr => new DataConstr(1, []);

const txOutRefTag = (ref: TxOutRef): DataConstr => new DataConstr(0, [
    new DataB(new Uint8Array(Buffer.from(ref.id.toString(), "hex"))),
    new DataI(Number(ref.index)),
]);

// plutus Address data -> buildooor Address
const addressFromData = (d: unknown): Address =>
    Address.fromData(d as Parameters<typeof Address.fromData>[0], IS_MAINNET ? "mainnet" : "testnet");

// guillotine complements of `target` in `parent` — mirrors stewardship `carve`
// (fixed order top, bottom, left, right)
const carveComplements = (parent: Rect, target: Rect): Rect[] => {
    const out: Rect[] = [];
    if (parent.y0 < target.y0) out.push({ x0: parent.x0, y0: parent.y0, x1: parent.x1, y1: target.y0 });
    if (target.y1 < parent.y1) out.push({ x0: parent.x0, y0: target.y1, x1: parent.x1, y1: parent.y1 });
    if (parent.x0 < target.x0) out.push({ x0: parent.x0, y0: target.y0, x1: target.x0, y1: target.y1 });
    if (target.x1 < parent.x1) out.push({ x0: target.x1, y0: target.y0, x1: parent.x1, y1: target.y1 });
    return out;
};

// sha256 + CIDv1 raw (mirror offchain/cid.ts)
import { createHash } from "node:crypto";
const cidV1Raw = (content: Uint8Array): Uint8Array => {
    const h = new Uint8Array(createHash("sha256").update(content).digest());
    const out = new Uint8Array(4 + h.length);
    out.set([0x01, 0x55, 0x12, 0x20]); out.set(h, 4);
    return out;
};

// ---- on-chain state -------------------------------------------------------

interface LeafInfo { idx: number; chunk: Uint8Array; utxo: UTxO; }

interface ChainState {
    pixels: Uint8Array;
    leaves: LeafInfo[];
    unhatched: number;
    committedImageUri: string | null;
    fetchedAt: string;
}

let cache: { state: ChainState; at: number } | undefined;
const CACHE_MS = 15_000;

export async function chainState(force = false): Promise<ChainState> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
    const utxos = await utxosAt(config.masterpieceAddress);
    const pixels = new Uint8Array(LINE_LENGTH * CANVAS_HEIGHT).fill(255);
    const leaves: LeafInfo[] = [];
    let committedImageUri: string | null = null;
    let unhatched = 0;

    for (const u of utxos) {
        const datum = u.resolved.datum;
        if (!datum) continue;
        const markers = amountOf(u, config.masterpiecePolicy, "");
        if (amountOf(u, config.masterpiecePolicy, ROOT_REF_NFT_NAME_HEX) === 1n) {
            const root = asConstr(datum);
            const metadata = root.fields[0];
            if (metadata instanceof Object && "map" in metadata) {
                for (const e of (metadata as { map: { fst: unknown; snd: unknown }[] }).map) {
                    if (Buffer.from(asBytes(e.fst)).toString("utf8") === "image")
                        committedImageUri = Buffer.from(asBytes(e.snd)).toString("utf8");
                }
            }
        } else if (markers === 1n) {
            const d = asConstr(datum);
            if (Number(d.constr) !== 1) continue;
            const idx = asInt(d.fields[0]);
            const chunk = asBytes(d.fields[2]);
            if (idx < 0 || idx >= N_LEAFS || chunk.length !== CHUNK_SIZE) continue;
            pixels.set(chunk, idx * CHUNK_SIZE);
            leaves.push({ idx, chunk, utxo: u });
        } else if (markers > 1n) {
            unhatched = Number(markers);
        }
    }
    leaves.sort((a, b) => a.idx - b.idx);
    const state: ChainState = {
        pixels, leaves, unhatched, committedImageUri,
        fetchedAt: new Date().toISOString(),
    };
    cache = { state, at: Date.now() };
    return state;
}

interface FreeNode { rect: Rect; utxo: UTxO; }

export async function freeNodes(): Promise<FreeNode[]> {
    const utxos = await utxosAt(config.stewardshipAddress);
    const out: FreeNode[] = [];
    for (const u of utxos) {
        if (amountOf(u, config.stewardshipPolicy, "") !== 1n) continue;
        if (!u.resolved.datum) continue;
        // Free = Constr 0 [ Constr 0 [x0,y0,x1,y1] ]
        const d = asConstr(u.resolved.datum);
        if (Number(d.constr) !== 0) continue;
        const c = asConstr(d.fields[0]);
        out.push({
            rect: { x0: asInt(c.fields[0]), y0: asInt(c.fields[1]), x1: asInt(c.fields[2]), y1: asInt(c.fields[3]) },
            utxo: u,
        });
    }
    return out;
}

interface Plot { rect: Rect; name: string; utxoRef: string; }

const NAME_RE = /^masterpiece-(\d+)-(\d+)-(\d+)-(\d+)$/;

export async function plotsOf(address: Address): Promise<{ plots: Plot[]; utxos: UTxO[] }> {
    const utxos = await utxosAt(address.toString());
    const plots: Plot[] = [];
    for (const u of utxos) {
        const j = u.resolved.value.toJson() as ValueJson;
        const assets = j[config.stewardshipPolicy];
        if (!assets) continue;
        for (const [nameHex, qty] of Object.entries(assets)) {
            if (BigInt(qty) < 1n) continue;
            const name = Buffer.from(nameHex, "hex").toString("utf8");
            const m = NAME_RE.exec(name);
            if (!m) continue;
            plots.push({
                rect: { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] },
                name,
                utxoRef: u.utxoRef.toString(),
            });
        }
    }
    return { plots, utxos };
}

// ---- marketplace orders ---------------------------------------------------

interface MarketListing {
    rect: Rect; name: string; seller: string; pricePerPixel: bigint;
    priceTotal: bigint; utxoRef: string;
}
interface MarketRequest {
    rect: Rect; name: string; requester: string; offerLovelace: bigint; utxoRef: string;
}

interface MarketOrders { listings: MarketListing[]; requests: MarketRequest[]; }

export async function marketOrders(): Promise<MarketOrders> {
    const utxos = await utxosAt(config.marketplaceAddress);
    const listings: MarketListing[] = [];
    const requests: MarketRequest[] = [];
    for (const u of utxos) {
        if (!u.resolved.datum || !(u.resolved.datum instanceof DataConstr)) continue;
        try {
            const d = asConstr(u.resolved.datum);
            if (Number(d.constr) === 0) {
                // Listing { seller, pricePerPixel } — the sold deed is the
                // stewardship asset held by the utxo
                const seller = addressFromData(d.fields[0]);
                const ppp = BigInt(asInt(d.fields[1]));
                const assets = (u.resolved.value.toJson() as ValueJson)[config.stewardshipPolicy];
                if (!assets) continue;
                for (const [nameHex, qty] of Object.entries(assets)) {
                    if (BigInt(qty) !== 1n) continue;
                    const name = Buffer.from(nameHex, "hex").toString("utf8");
                    const m = NAME_RE.exec(name);
                    if (!m) continue;
                    const rect = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
                    listings.push({
                        rect, name, seller: seller.toString(),
                        pricePerPixel: ppp, priceTotal: ppp * rectArea(rect),
                        utxoRef: u.utxoRef.toString(),
                    });
                }
            } else if (Number(d.constr) === 1) {
                // Request { requester, coords } — the offer is the utxo value
                const requester = addressFromData(d.fields[0]);
                const c = asConstr(d.fields[1]);
                const rect = { x0: asInt(c.fields[0]), y0: asInt(c.fields[1]), x1: asInt(c.fields[2]), y1: asInt(c.fields[3]) };
                requests.push({
                    rect, name: Buffer.from(rectName(rect)).toString("utf8"),
                    requester: requester.toString(),
                    offerLovelace: lovelacesOf(u),
                    utxoRef: u.utxoRef.toString(),
                });
            }
        } catch { /* ill-formed datum: not an order */ }
    }
    return { listings, requests };
}

// every minted deed (asset registry of the stewardship policy): claimed plots
interface DeedInfo { rect: Rect; name: string; }
let _deeds: { at: number; deeds: DeedInfo[] } | undefined;
export async function deedsRegistry(): Promise<DeedInfo[]> {
    if (_deeds && Date.now() - _deeds.at < 30_000) return _deeds.deeds;
    const deeds: DeedInfo[] = [];
    for (let page = 1; page < 100; page++) {
        const res = await fetch(`${BLOCKFROST_URL}/assets/policy/${config.stewardshipPolicy}?page=${page}&count=100`, { headers: bfHeaders() });
        if (res.status === 404) break;
        if (!res.ok) throw new Error(`blockfrost assets/policy: ${res.status}`);
        const rows = await res.json() as { asset: string; quantity: string }[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
            if (r.quantity !== "1") continue;
            const nameHex = r.asset.slice(config.stewardshipPolicy.length);
            const name = Buffer.from(nameHex, "hex").toString("utf8");
            const m = NAME_RE.exec(name);
            if (!m) continue;
            deeds.push({ rect: { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] }, name });
        }
        if (rows.length < 100) break;
    }
    _deeds = { at: Date.now(), deeds };
    return deeds;
}

// funding/collateral selection from a user's wallet utxos.
// NEVER pick utxos that carry a reference script (spending one would destroy
// the deployment — and referencing + spending the same utxo is rejected with
// ReferenceInputsNotDisjointFromInputs anyway).
const PROTECTED_REFS = [
    `${config.stewardshipRefScript.txHash}#${config.stewardshipRefScript.index}`,
    `${config.masterpieceRefScript.txHash}#${config.masterpieceRefScript.index}`,
    `${config.marketplaceRefScript.txHash}#${config.marketplaceRefScript.index}`,
];
function pickFunding(utxos: UTxO[], excludeRefs: string[] = []): { funding: UTxO[]; collateral: UTxO } {
    const usable = utxos.filter((u) =>
        !excludeRefs.includes(u.utxoRef.toString())
        && !PROTECTED_REFS.includes(u.utxoRef.toString())
        && u.resolved.refScript === undefined);
    const pure = usable.filter(isPureAda).sort((a, b) => Number(lovelacesOf(b) - lovelacesOf(a)));
    if (pure.length === 0) throw new Error("wallet has no pure-ADA utxo for fees/collateral");
    const collateral = pure.find((u) => lovelacesOf(u) >= 5_000_000n && lovelacesOf(u) <= 50_000_000n)
        ?? pure[pure.length - 1];
    const funding = pure.filter((u) => u !== collateral).slice(0, 3);
    if (funding.length === 0) throw new Error("wallet needs at least two pure-ADA utxos (funding + collateral)");
    return { funding, collateral };
}

// ---- tx builders ----------------------------------------------------------

const tokens = (policyHex: string, entries: [Uint8Array, bigint][]): Value =>
    entries.reduce((v, [name, amt]) =>
        Value.add(v, Value.singleAsset(new Hash28(policyHex), name, amt)), Value.zero);

const rectIntersect = (a: Rect, b: Rect): Rect | null => {
    const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
    return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null;
};

// one claim tx spends exactly one Free node (the contract allows a single
// script input), claiming `rect` which must be contained in it
async function buildOneClaim(
    userAddr: Address, node: FreeNode, rect: Rect,
    funding: UTxO[], collateral: UTxO, refO: UTxO,
): Promise<Tx> {
    const price = rectArea(rect) * LOVELACE_PER_PIXEL;

    // guillotine complements, validator order: top, bottom, left, right
    const F = node.rect, C = rect;
    const complements: Rect[] = [];
    if (F.y0 < C.y0) complements.push({ x0: F.x0, y0: F.y0, x1: F.x1, y1: C.y0 });
    if (C.y1 < F.y1) complements.push({ x0: F.x0, y0: C.y1, x1: F.x1, y1: F.y1 });
    if (F.x0 < C.x0) complements.push({ x0: F.x0, y0: C.y0, x1: C.x0, y1: C.y1 });
    if (C.x1 < F.x1) complements.push({ x0: C.x1, y0: C.y0, x1: F.x1, y1: C.y1 });

    const k = complements.length;
    const deedName = rectName(rect);
    const mintEntries: [Uint8Array, bigint][] = [[deedName, 1n]];
    if (k - 1 !== 0) mintEntries.push([EMPTY_NAME, BigInt(k - 1)]);

    const args: ITxBuildArgs = {
        inputs: [
            { utxo: node.utxo, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(rect) } },
            ...funding,
        ],
        collaterals: [collateral],
        mints: [{
            value: tokens(config.stewardshipPolicy, mintEntries),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            ...complements.map((r) => ({
                address: Address.fromString(config.stewardshipAddress),
                value: Value.add(Value.lovelaces(3_000_000n), tokens(config.stewardshipPolicy, [[EMPTY_NAME, 1n]])),
                datum: freeDatum(r),
            })),
            { address: Address.fromString(config.protocolStewardAddress), value: Value.lovelaces(price) },
            { address: userAddr, value: Value.add(Value.lovelaces(2_000_000n), tokens(config.stewardshipPolicy, [[deedName, 1n]])) },
        ],
        metadata: deedCip25(config.stewardshipPolicy, [rect]),
        changeAddress: userAddr,
    };
    return (await txBuilder()).build(args);
}

// a selection may span several Free nodes: claim the intersection with each
// node in its own tx, chaining each tx's change output into the next one's
// funding so a single pure-ADA utxo can pay for the whole batch.
// (the txs must be submitted in order; the collateral is shared — it is only
// ever consumed on phase-2 failure, so every pending tx may reference it)
export async function buildClaimTxs(userAddr: Address, rect: Rect): Promise<Tx[]> {
    if (!rectValid(rect)) throw new Error("invalid rect");
    const nodes = await freeNodes();
    const parts = nodes
        .map((node) => ({ node, part: rectIntersect(node.rect, rect) }))
        .filter((p): p is { node: FreeNode; part: Rect } => p.part !== null)
        .sort((a, b) => a.part.y0 - b.part.y0 || a.part.x0 - b.part.x0);
    // free nodes tile disjointly, so full coverage <=> the areas add up
    const covered = parts.reduce((s, p) => s + rectArea(p.part), 0n);
    if (covered !== rectArea(rect))
        throw new Error("selection overlaps already-claimed pixels");

    const { refO } = await refScripts();
    const picked = pickFunding(await utxosAt(userAddr.toString()));
    const collateral = picked.collateral;
    let funding = picked.funding;

    const txs: Tx[] = [];
    for (const { node, part } of parts) {
        const tx = await buildOneClaim(userAddr, node, part, funding, collateral, refO);
        txs.push(tx);
        if (txs.length === parts.length) break;
        const changeIdx = tx.body.outputs.length - 1;
        const change = tx.body.outputs[changeIdx];
        if (change.address.toString() !== userAddr.toString())
            throw new Error("unexpected tx shape: change output not at user address");
        funding = [new UTxO({
            utxoRef: new TxOutRef({ id: tx.hash.toString(), index: changeIdx }),
            resolved: change,
        })];
    }
    return txs;
}

export interface PixelEdit { x: number; y: number; v: number; }

export async function buildEditTx(
    userAddr: Address, leafIdx: number, edits: PixelEdit[],
    fundingOverride?: { funding: UTxO[]; collateral: UTxO },
): Promise<Tx> {
    if (!Number.isInteger(leafIdx) || leafIdx < 0 || leafIdx >= N_LEAFS) throw new Error("bad leafIdx");
    if (edits.length === 0) throw new Error("no pixel edits");

    const { plots, utxos: userUtxos } = await plotsOf(userAddr);
    if (plots.length === 0) throw new Error("address owns no plots");

    const state = await chainState(true);
    const leaf = state.leaves.find((l) => l.idx === leafIdx);
    if (!leaf) throw new Error(`leaf ${leafIdx} is not hatched yet`);

    // apply edits; every changed pixel must be inside one of the user's plots
    // and inside this leaf's rows
    const y0 = leafIdx * ROWS_PER_LEAF, y1 = y0 + ROWS_PER_LEAF;
    const newChunk = new Uint8Array(leaf.chunk);
    const touched = new Set<string>();
    for (const e of edits) {
        if (!Number.isInteger(e.x) || !Number.isInteger(e.y) || !Number.isInteger(e.v)
            || e.x < 0 || e.x >= LINE_LENGTH || e.y < y0 || e.y >= y1 || e.v < 0 || e.v > 255)
            throw new Error(`pixel out of range: ${JSON.stringify(e)}`);
        const plot = plots.find((p) =>
            p.rect.x0 <= e.x && e.x < p.rect.x1 && p.rect.y0 <= e.y && e.y < p.rect.y1);
        if (!plot) throw new Error(`pixel (${e.x},${e.y}) is not inside any of your plots`);
        touched.add(plot.name);
        newChunk[(e.y - y0) * LINE_LENGTH + e.x] = e.v;
    }

    // the validator wants the covering rects sorted by x0
    const stewardRects = plots
        .filter((p) => touched.has(p.name))
        .map((p) => p.rect)
        .sort((a, b) => a.x0 - b.x0);

    // deed utxos referenced; holder (this address) must sign
    const deedRefs = [...new Set(plots.filter((p) => touched.has(p.name)).map((p) => p.utxoRef))];
    const deedUtxos = userUtxos.filter((u) => deedRefs.includes(u.utxoRef.toString()));

    const { refM } = await refScripts();
    const { funding, collateral } = fundingOverride ?? pickFunding(userUtxos, deedRefs);

    const pkh = userAddr.paymentCreds.hash;

    const args: ITxBuildArgs = {
        inputs: [
            { utxo: leaf.utxo, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit(stewardRects) } },
            ...funding,
        ],
        readonlyRefInputs: deedUtxos,
        requiredSigners: [pkh],
        collaterals: [collateral],
        outputs: [{
            address: Address.fromString(config.masterpieceAddress),
            value: Value.add(
                Value.lovelaces(lovelacesOf(leaf.utxo)),
                tokens(config.masterpiecePolicy, [[EMPTY_NAME, 1n]])
            ),
            datum: leafDatum(leafIdx, newChunk, cidV1Raw(newChunk)),
        }],
        changeAddress: userAddr,
    };
    return (await txBuilder()).build(args);
}

// edits across several leaves as ONE chained batch: leaf inputs are disjoint,
// funding chains through each tx's change (a single wallet utxo funds the
// whole batch), the collateral is shared (only ever consumed on phase-2
// failure). Submit strictly in order. Pairs with CIP-103 bulk signing.
export async function buildEditBatchTxs(
    userAddr: Address, groups: { leafIdx: number; pixels: PixelEdit[] }[],
): Promise<Tx[]> {
    if (!Array.isArray(groups) || groups.length === 0) throw new Error("no edits");
    const seen = new Set(groups.map((g) => g.leafIdx));
    if (seen.size !== groups.length) throw new Error("duplicate leafIdx in batch");

    const picked = pickFunding(await utxosAt(userAddr.toString()));
    const collateral = picked.collateral;
    let funding = picked.funding;

    const txs: Tx[] = [];
    for (const g of groups) {
        const tx = await buildEditTx(userAddr, g.leafIdx, g.pixels, { funding, collateral });
        txs.push(tx);
        if (txs.length === groups.length) break;
        const changeIdx = tx.body.outputs.length - 1;
        const change = tx.body.outputs[changeIdx];
        if (change.address.toString() !== userAddr.toString())
            throw new Error("unexpected tx shape: change output not at user address");
        funding = [new UTxO({
            utxoRef: new TxOutRef({ id: tx.hash.toString(), index: changeIdx }),
            resolved: change,
        })];
    }
    return txs;
}

// ---- marketplace tx builders ----------------------------------------------

const MIN_LISTING_LOVELACE = 2_000_000n;

async function marketUtxo(utxoRef: string): Promise<UTxO> {
    const u = (await utxosAt(config.marketplaceAddress)).find((x) => x.utxoRef.toString() === utxoRef);
    if (!u) throw new Error("order not found (already taken or canceled?)");
    return u;
}

// send a deed from the user's wallet into a fresh Listing
export async function buildMarketListTx(userAddr: Address, name: string, pricePerPixel: bigint): Promise<Tx> {
    if (pricePerPixel <= 0n) throw new Error("pricePerPixel must be positive");
    const { plots, utxos } = await plotsOf(userAddr);
    const plot = plots.find((p) => p.name === name);
    if (!plot) throw new Error(`this wallet does not hold the deed "${name}"`);
    const deedU = utxos.find((u) => u.utxoRef.toString() === plot.utxoRef)!;
    const { funding } = pickFunding(utxos, [plot.utxoRef]);
    return (await txBuilder()).build({
        inputs: [deedU, ...funding],
        outputs: [{
            address: Address.fromString(config.marketplaceAddress),
            value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.stewardshipPolicy, [[rectName(plot.rect), 1n]])),
            datum: listingDatum(userAddr, pricePerPixel),
        }],
        changeAddress: userAddr,
    });
}

// buy a whole listing: pay the seller, take the listed value
export async function buildMarketBuyTx(userAddr: Address, utxoRef: string): Promise<Tx> {
    const { listings } = await marketOrders();
    const l = listings.find((x) => x.utxoRef === utxoRef);
    if (!l) throw new Error("listing not found (already sold or canceled?)");
    const listingU = await marketUtxo(utxoRef);
    const { refK } = await refScripts();
    const { funding, collateral } = pickFunding(await utxosAt(userAddr.toString()));
    return (await txBuilder()).build({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(l.rect) } },
            ...funding,
        ],
        collaterals: [collateral],
        outputs: [
            { address: Address.fromString(l.seller), value: Value.lovelaces(l.priceTotal), datum: txOutRefTag(listingU.utxoRef) },
            { address: userAddr, value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.stewardshipPolicy, [[rectName(l.rect), 1n]])) },
        ],
        changeAddress: userAddr,
    });
}

// buy any sub-rect of a listing: the tx composes the stewardship `carve` mint;
// every complement goes back as a fresh Listing on the same terms
export async function buildMarketPartialBuyTx(userAddr: Address, utxoRef: string, bought: Rect): Promise<Tx> {
    if (!rectValid(bought)) throw new Error("invalid rect");
    const { listings } = await marketOrders();
    const l = listings.find((x) => x.utxoRef === utxoRef);
    if (!l) throw new Error("listing not found (already sold or canceled?)");
    const parent = l.rect;
    const contained = parent.x0 <= bought.x0 && bought.x1 <= parent.x1
        && parent.y0 <= bought.y0 && bought.y1 <= parent.y1;
    if (!contained) throw new Error("bought rect is not inside the listed deed");
    if (rectArea(bought) === rectArea(parent)) return buildMarketBuyTx(userAddr, utxoRef);

    const listingU = await marketUtxo(utxoRef);
    const comps = carveComplements(parent, bought);
    const { refO, refK } = await refScripts();
    const { funding, collateral } = pickFunding(await utxosAt(userAddr.toString()));
    const mintEntries: [Uint8Array, bigint][] = [
        [rectName(parent), -1n], [rectName(bought), 1n],
        ...comps.map((c): [Uint8Array, bigint] => [rectName(c), 1n]),
    ];
    return (await txBuilder()).build({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(parent, bought) } },
            ...funding,
        ],
        collaterals: [collateral],
        mints: [{
            value: tokens(config.stewardshipPolicy, mintEntries),
            script: { ref: refO, redeemer: oMintCarve(parent, bought) },
        }],
        outputs: [
            // complements relisted on the SAME terms: reuse the original datum
            ...comps.map((c) => ({
                address: Address.fromString(config.marketplaceAddress),
                value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.stewardshipPolicy, [[rectName(c), 1n]])),
                datum: asConstr(listingU.resolved.datum),
            })),
            { address: Address.fromString(l.seller), value: Value.lovelaces(l.pricePerPixel * rectArea(bought)), datum: txOutRefTag(listingU.utxoRef) },
            { address: userAddr, value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.stewardshipPolicy, [[rectName(bought), 1n]])) },
        ],
        // CIP-25 artwork for every deed this carve mints (bought + complements)
        metadata: deedCip25(config.stewardshipPolicy, [bought, ...comps]),
        changeAddress: userAddr,
    });
}

// cancel an own order (listing or request): sign + take the value back
export async function buildMarketCancelTx(userAddr: Address, utxoRef: string): Promise<Tx> {
    const orderU = await marketUtxo(utxoRef);
    const d = asConstr(orderU.resolved.datum);
    const steward = addressFromData(d.fields[0]);
    if (steward.paymentCreds.hash.toString() !== userAddr.paymentCreds.hash.toString())
        throw new Error("only the order's steward can cancel it");
    const redeemer = Number(d.constr) === 0 ? mListingCancel() : mRequestCancel();
    const { refK } = await refScripts();
    const { funding, collateral } = pickFunding(await utxosAt(userAddr.toString()));
    return (await txBuilder()).build({
        inputs: [
            { utxo: orderU, referenceScript: { refUtxo: refK, datum: "inline", redeemer } },
            ...funding,
        ],
        collaterals: [collateral],
        requiredSigners: [userAddr.paymentCreds.hash],
        outputs: [{ address: userAddr, value: orderU.resolved.value }],
        changeAddress: userAddr,
    });
}

// lock an offer requesting the deed named after `rect`
export async function buildMarketRequestTx(userAddr: Address, rect: Rect, offerLovelace: bigint): Promise<Tx> {
    if (!rectValid(rect)) throw new Error("invalid rect");
    if (offerLovelace < MIN_LISTING_LOVELACE) throw new Error("offer below min-ada");
    const deeds = await deedsRegistry();
    const name = Buffer.from(rectName(rect)).toString("utf8");
    if (!deeds.some((x) => x.name === name))
        throw new Error(`no deed "${name}" exists on-chain — nobody could fill this request`);
    const { funding } = pickFunding(await utxosAt(userAddr.toString()));
    return (await txBuilder()).build({
        inputs: funding,
        outputs: [{
            address: Address.fromString(config.marketplaceAddress),
            value: Value.lovelaces(offerLovelace),
            datum: requestDatum(userAddr, rect),
        }],
        changeAddress: userAddr,
    });
}

// fill a request with a deed from the user's wallet, taking the offer
export async function buildMarketFillTx(userAddr: Address, utxoRef: string): Promise<Tx> {
    const { requests } = await marketOrders();
    const r = requests.find((x) => x.utxoRef === utxoRef);
    if (!r) throw new Error("request not found (already filled or canceled?)");
    const requestU = await marketUtxo(utxoRef);
    const { plots, utxos } = await plotsOf(userAddr);
    const plot = plots.find((p) => p.name === r.name);
    if (!plot) throw new Error(`this wallet does not hold the requested deed "${r.name}"`);
    const deedU = utxos.find((u) => u.utxoRef.toString() === plot.utxoRef)!;
    const { refK } = await refScripts();
    const { funding, collateral } = pickFunding(utxos, [plot.utxoRef]);
    return (await txBuilder()).build({
        inputs: [
            { utxo: requestU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
            deedU,
            ...funding,
        ],
        collaterals: [collateral],
        outputs: [
            { address: Address.fromString(r.requester), value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.stewardshipPolicy, [[rectName(r.rect), 1n]])) },
        ],
        changeAddress: userAddr,
    });
}


// ---- exports used by the http layer --------------------------------------

/** reset the canvas cache (local server only; serverless has no shared mem) */
export function invalidateCache(): void { cache = undefined; }

/** JSON.stringify replacer that renders bigint as string */
export const jsonReplacer = (_k: string, v: unknown): unknown =>
    typeof v === "bigint" ? v.toString() : v;
