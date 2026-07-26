// ===========================================================================
//  Transaction building IN THE BROWSER.
//
//  Chain state comes through the /bf proxy, funding/collateral come from the
//  connected CIP-30 wallet, and buildooor runs the validators locally during
//  build — an invalid tx fails HERE, before the wallet ever shows a prompt.
//  Returns unsigned tx cbor hex, ready for signAndSubmit / signAndSubmitAll.
// ===========================================================================
import { Address, Value, UTxO, TxOutRef, type Tx } from "@harmoniclabs/buildooor";
import type { WalletApi } from "@harmoniclabs/use-cardano-wallet";
import type { MarketListing, MarketRequest, PixelEdit, Rect } from "./api.js";
import {
    config, ROWS_PER_LEAF, MIN_LISTING_LOVELACE, MIN_LOVELACE_PER_PIXEL,
    txBuilder, refScripts, walletFunding, walletDeed, marketUtxo, lovelacesOf,
    freeNodes, priceConfig, isProtocolOwner, tokens, bytesToHex, PRICE_NFT_NAME,
    rectName, rectNameStr, rectArea, rectValid, rectContains, carveComplements, rectUnionIfMergeable,
    freeDatum, listingDatum, requestDatum, txOutRefTag, lovelacePerPixelDatum,
    oClaim, oOwnerClaim, oMintFree, oMintCarve, oMintMerge, oPriceChange,
    mBuy, mPartialBuy, mListingCancel, mFill, mRequestCancel,
    asConstr, type FreeNode,
} from "./chain.js";
import { deedCip25 } from "./deedImage.js";
import type { PlacedSprite } from "./pixelify.js";
import { staleLeaves } from "./masterpieceRoot.js";
// the edit-tx core lives in a DOM-free module shared with the prebuilder worker
import {
    EMPTY_NAME, NAME_RE, toHex, chainChange, buildOneEdit, buildCommitTxs, leafOutputOf,
    buildEditBatchTxsFromCbor, type Plot, type EditedLeaf,
} from "./editBuild.js";

const rectIntersect = (a: Rect, b: Rect): Rect | null => {
    const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
    return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null;
};

// ---- claim ----------------------------------------------------------------

async function buildOneClaim(
    outAddr: Address, isOwner: boolean, node: FreeNode, rect: Rect, f: UTxO[], refO: UTxO,
    price: bigint, priceRef: UTxO,
): Promise<Tx> {
    const complements = carveComplements(node.rect, rect);
    const k = complements.length;
    const deedName = rectName(rect);
    const mintEntries: [Uint8Array, bigint][] = [[deedName, 1n]];
    if (k - 1 !== 0) mintEntries.push([EMPTY_NAME, BigInt(k - 1)]);

    const complementOuts = complements.map((r) => ({
        address: Address.fromString(config.ownershipAddress),
        value: Value.add(Value.lovelaces(3_000_000n), tokens(config.ownershipPolicy, [[EMPTY_NAME, 1n]])),
        datum: freeDatum(r),
    }));
    const deedOut = {
        address: outAddr,
        value: Value.add(Value.lovelaces(2_000_000n), tokens(config.ownershipPolicy, [[deedName, 1n]])),
    };

    // The protocol owner claims free space for free via the dedicated
    // `ownerClaim` redeemer: no payment output, the owner signs, and EVERY
    // non-contract output (deed + change) must go to the protocol owner.
    return (await txBuilder()).build({
        inputs: [
            {
                utxo: node.utxo,
                referenceScript: {
                    refUtxo: refO, datum: "inline",
                    redeemer: isOwner ? oOwnerClaim(rect) : oClaim(rect),
                },
            },
            ...f,
        ],
        // non-owner claims reference the price config (NFT-validated) to prove
        // the payment matches the current owner-set price; owner claims are free
        ...(isOwner
            ? { requiredSigners: [outAddr.paymentCreds.hash] }
            : { readonlyRefInputs: [priceRef] }),
        mints: [{
            value: tokens(config.ownershipPolicy, mintEntries),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: isOwner
            ? [...complementOuts, deedOut]
            : [
                ...complementOuts,
                { address: Address.fromString(config.protocolOwnerAddress), value: Value.lovelaces(price) },
                deedOut,
            ],
        metadata: deedCip25(config.ownershipPolicy, [rect]),
        changeAddress: outAddr,
    });
}

/** the (mempool) utxo of the deed a claim tx just minted, for chained edits */
function deedUtxoOf(tx: Tx, rect: Rect, addr: Address): UTxO {
    const nameHex = bytesToHex(rectName(rect));
    const outs = tx.body.outputs;
    for (let i = 0; i < outs.length; i++) {
        if (outs[i].address.toString() !== addr.toString()) continue;
        const assets = (outs[i].value.toJson() as Record<string, Record<string, unknown>>)[config.ownershipPolicy];
        if (assets && assets[nameHex] !== undefined)
            return new UTxO({ utxoRef: new TxOutRef({ id: tx.hash.toString(), index: i }), resolved: outs[i] });
    }
    throw new Error("deed output not found in claim tx");
}

/** opaque sprite pixels grouped into one edit per masterpiece leaf */
function spriteLeafGroups(s: PlacedSprite): { leafIdx: number; pixels: PixelEdit[] }[] {
    const g = new Map<number, PixelEdit[]>();
    for (let sy = 0; sy < s.h; sy++) {
        for (let sx = 0; sx < s.w; sx++) {
            const i = sy * s.w + sx;
            if (!s.opaque[i]) continue;
            const y = s.y + sy;
            const leaf = Math.floor(y / ROWS_PER_LEAF);
            if (!g.has(leaf)) g.set(leaf, []);
            g.get(leaf)!.push({ x: s.x + sx, y, v: s.pixels[i] });
        }
    }
    return [...g].map(([leafIdx, pixels]) => ({ leafIdx, pixels })).sort((a, b) => a.leafIdx - b.leafIdx);
}

/**
 * One chained tx per intersected free node; submit strictly in order.
 *
 * If a `sprite` is placed, its pixels are painted in the SAME batch: after the
 * claim txs, one edit tx per touched leaf references the just-minted deed(s)
 * (mempool) and spends the chained change, so the whole claim→paint sequence
 * signs in one CIP-103 prompt and needs no manual visit to the Studio page.
 */
export async function buildClaimTxs(
    api: WalletApi, address: string, rect: Rect, sprite?: PlacedSprite,
): Promise<string[]> {
    if (!rectValid(rect)) throw new Error("invalid rect");
    const userAddr = Address.fromString(address);
    // if the connected wallet is the protocol owner, claim for free via
    // `ownerClaim`; the contract requires all non-contract outputs (deed +
    // change) to be the canonical protocol-owner address, so use that.
    const ownerAddr = Address.fromString(config.protocolOwnerAddress);
    const isOwner = userAddr.paymentCreds.hash.toString() === ownerAddr.paymentCreds.hash.toString();
    const outAddr = isOwner ? ownerAddr : userAddr;

    const nodes = await freeNodes();
    const parts = nodes
        .map((node) => ({ node, part: rectIntersect(node.rect, rect) }))
        .filter((p): p is { node: FreeNode; part: Rect } => p.part !== null)
        .sort((a, b) => a.part.y0 - b.part.y0 || a.part.x0 - b.part.x0);
    const covered = parts.reduce((s, p) => s + rectArea(p.part), 0n);
    if (covered !== rectArea(rect))
        throw new Error("selection overlaps already-claimed pixels");

    const editGroups = sprite ? spriteLeafGroups(sprite) : [];

    // the current owner-set price, read from the NFT-validated config node;
    // non-owner claims reference it and pay accordingly
    const { utxo: priceRef, pricePerPixel } = await priceConfig();

    // funding must cover the WHOLE chain (change threads through every tx): each
    // claim's price + complement/deed min-adas, plus per-leaf edit fees
    const claimCost = parts.reduce((s, { node, part }) => {
        const price = isOwner ? 0n : rectArea(part) * pricePerPixel;
        const comps = BigInt(carveComplements(node.rect, part).length);
        return s + price + comps * 3_000_000n + 2_000_000n;   // complements (3₳) + deed (2₳)
    }, 0n);
    const editFees = BigInt(editGroups.length) * 2_000_000n;   // edit + commit per leaf

    const { refO } = await refScripts();
    let f = await walletFunding(api, [], claimCost + editFees);
    const txs: Tx[] = [];
    // synthetic plots for the paint step: the freshly-minted deeds, referenced
    // straight out of the (still-in-mempool) claim outputs
    const claimPlots: Plot[] = [];
    for (let i = 0; i < parts.length; i++) {
        const { node, part } = parts[i];
        const price = isOwner ? 0n : rectArea(part) * pricePerPixel;
        const tx = await buildOneClaim(outAddr, isOwner, node, part, f, refO, price, priceRef);
        txs.push(tx);
        claimPlots.push({ rect: part, name: rectNameStr(part), utxo: deedUtxoOf(tx, part, outAddr) });
        // thread change to the next claim, or (on the last claim) to the edits
        if (i < parts.length - 1 || editGroups.length > 0) f = [chainChange(tx, outAddr)];
    }

    const edited: EditedLeaf[] = [];
    for (const g of editGroups) {
        const res = await buildOneEdit(outAddr, claimPlots, g.leafIdx, g.pixels, f);
        if (!res) continue;   // this leaf's pixels already match the canvas — no tx
        txs.push(res.tx);
        edited.push({ leafIdx: g.leafIdx, newCid: res.newCid, leafUtxo: leafOutputOf(res.tx) });
        f = [chainChange(res.tx, outAddr)];
    }
    // sync the painted leaves into the root's CIP-68 whole-image CID
    const { txs: commitTxs } = await buildCommitTxs(edited, f, outAddr);
    txs.push(...commitTxs);
    return txs.map(toHex);
}

/**
 * Protocol-owner: retune the price per pixel. Spends the price-config node
 * (LovelacePerPixel state) and re-creates it at the ownership script with the
 * price NFT preserved and the new value. The contract checks the owner's
 * signature and the floor; only the owner's wallet can produce that signature.
 */
export async function buildSetPriceTx(api: WalletApi, address: string, newPricePerPixel: bigint): Promise<string> {
    if (!isProtocolOwner(address)) throw new Error("only the protocol owner can change the price");
    if (newPricePerPixel < MIN_LOVELACE_PER_PIXEL) throw new Error("price must be at least 1 ADA per pixel");
    const userAddr = Address.fromString(address);
    const ownerAddr = Address.fromString(config.protocolOwnerAddress);
    const { utxo: cfg } = await priceConfig();
    const { refO } = await refScripts();
    const f = await walletFunding(api, [cfg.utxoRef.toString()]);
    return toHex(await (await txBuilder()).build({
        inputs: [
            { utxo: cfg, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oPriceChange() } },
            ...f,
        ],
        requiredSigners: [ownerAddr.paymentCreds.hash],
        outputs: [{
            address: Address.fromString(config.ownershipAddress),
            value: Value.add(Value.lovelaces(lovelacesOf(cfg)), tokens(config.ownershipPolicy, [[PRICE_NFT_NAME, 1n]])),
            datum: lovelacePerPixelDatum(newPricePerPixel),
        }],
        changeAddress: userAddr,
    }));
}

// ---- edit -----------------------------------------------------------------
// The edit-tx core (buildOneEdit / buildEditBatch*) lives in editBuild.ts so it
// can also run inside the prebuilder worker. This thin wrapper just supplies the
// wallet's utxos from the CIP-30 api (which only the main thread can reach).

/** one chained tx per touched leaf; submit strictly in order */
export async function buildEditBatchTxs(
    api: WalletApi, address: string, groups: { leafIdx: number; pixels: PixelEdit[] }[],
): Promise<string[]> {
    return buildEditBatchTxsFromCbor((await api.getUtxos()) ?? [], address, groups);
}

/**
 * "Catch up" the root: one `commit` tx per leaf whose current CID is ahead of
 * the root (edited before commits were automatic). Permissionless; after this
 * the on-chain CIP-68 image reflects the latest art (and IPFS pinning passes).
 */
export async function buildCatchupCommitTxs(api: WalletApi, address: string): Promise<string[]> {
    const stale = await staleLeaves();
    if (stale.length === 0) throw new Error("nothing to commit — the committed image is already up to date");
    const userAddr = Address.fromString(address);
    const f = await walletFunding(api, [], BigInt(stale.length) * 1_000_000n);
    const { txs } = await buildCommitTxs(stale, f, userAddr);
    return txs.map(toHex);
}

// ---- carve (split ownership) ----------------------------------------------

/**
 * Split an owned deed into a sub-rect `target` + its ≤4 guillotine complements,
 * ALL minted back to the owner (unlike a marketplace partial-buy, where `target`
 * goes to the buyer). Burns the parent deed and mints the pieces in one tx via
 * the ownership `carve` redeemer — the pieces can then be listed/sold/edited
 * independently. Consent is inherent in spending the parent from the wallet.
 */
export async function buildCarveTx(
    api: WalletApi, address: string, parentName: string, target: Rect,
): Promise<string> {
    if (!rectValid(target)) throw new Error("invalid rect");
    const m = NAME_RE.exec(parentName);
    if (!m) throw new Error("not a deed name");
    const parent: Rect = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
    if (!rectContains(parent, target)) throw new Error("the selection is not inside this deed");
    if (rectArea(target) === rectArea(parent)) throw new Error("the selection is the whole deed — nothing to split");

    const userAddr = Address.fromString(address);
    const deedU = await walletDeed(api, parentName);
    const comps = carveComplements(parent, target);
    const pieces = [target, ...comps];
    const { refO } = await refScripts();
    const mintEntries: [Uint8Array, bigint][] = [
        [rectName(parent), -1n], [rectName(target), 1n],
        ...comps.map((c): [Uint8Array, bigint] => [rectName(c), 1n]),
    ];
    const f = await walletFunding(api, [deedU.utxoRef.toString()], BigInt(pieces.length) * MIN_LISTING_LOVELACE);
    return toHex(await (await txBuilder()).build({
        inputs: [deedU, ...f],
        mints: [{
            value: tokens(config.ownershipPolicy, mintEntries),
            script: { ref: refO, redeemer: oMintCarve(parent, target) },
        }],
        outputs: pieces.map((r) => ({
            address: userAddr,
            value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(r), 1n]])),
        })),
        // CIP-25 artwork for every piece this carve mints
        metadata: deedCip25(config.ownershipPolicy, pieces),
        changeAddress: userAddr,
    }));
}

// ---- marketplace ----------------------------------------------------------

export async function buildMarketListTx(api: WalletApi, address: string, name: string, pricePerPixel: bigint): Promise<string> {
    if (pricePerPixel <= 0n) throw new Error("pricePerPixel must be positive");
    const userAddr = Address.fromString(address);
    const deedU = await walletDeed(api, name);
    const m = NAME_RE.exec(name);
    if (!m) throw new Error("not a deed name");
    const rect: Rect = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
    const f = await walletFunding(api, [deedU.utxoRef.toString()], MIN_LISTING_LOVELACE);
    return toHex(await (await txBuilder()).build({
        inputs: [deedU, ...f],
        outputs: [{
            address: Address.fromString(config.marketplaceAddress),
            value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(rect), 1n]])),
            datum: listingDatum(userAddr, pricePerPixel),
        }],
        changeAddress: userAddr,
    }));
}

export async function buildMarketBuyTx(api: WalletApi, address: string, l: MarketListing): Promise<string> {
    const userAddr = Address.fromString(address);
    const listingU = await marketUtxo(l.utxoRef);
    const { refK } = await refScripts();
    const f = await walletFunding(api, [], BigInt(l.priceTotal) + MIN_LISTING_LOVELACE);
    return toHex(await (await txBuilder()).build({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(l.rect) } },
            ...f,
        ],
        outputs: [
            { address: Address.fromString(l.seller), value: Value.lovelaces(BigInt(l.priceTotal)), datum: txOutRefTag(listingU.utxoRef) },
            { address: userAddr, value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(l.rect), 1n]])) },
        ],
        changeAddress: userAddr,
    }));
}

export async function buildMarketPartialBuyTx(api: WalletApi, address: string, l: MarketListing, bought: Rect): Promise<string> {
    if (!rectValid(bought)) throw new Error("invalid rect");
    const parent = l.rect;
    if (!rectContains(parent, bought)) throw new Error("bought rect is not inside the listed deed");
    if (rectArea(bought) === rectArea(parent)) return buildMarketBuyTx(api, address, l);

    const userAddr = Address.fromString(address);
    const listingU = await marketUtxo(l.utxoRef);
    const comps = carveComplements(parent, bought);
    const { refO, refK } = await refScripts();
    const buyTarget = BigInt(l.pricePerPixel) * rectArea(bought)
        + BigInt(comps.length + 1) * MIN_LISTING_LOVELACE;   // relisted comps + own deed
    const f = await walletFunding(api, [], buyTarget);
    const mintEntries: [Uint8Array, bigint][] = [
        [rectName(parent), -1n], [rectName(bought), 1n],
        ...comps.map((c): [Uint8Array, bigint] => [rectName(c), 1n]),
    ];
    return toHex(await (await txBuilder()).build({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(parent, bought) } },
            ...f,
        ],
        mints: [{
            value: tokens(config.ownershipPolicy, mintEntries),
            script: { ref: refO, redeemer: oMintCarve(parent, bought) },
        }],
        outputs: [
            // complements relisted on the SAME terms: reuse the original datum
            ...comps.map((c) => ({
                address: Address.fromString(config.marketplaceAddress),
                value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(c), 1n]])),
                datum: asConstr(listingU.resolved.datum),
            })),
            { address: Address.fromString(l.seller), value: Value.lovelaces(BigInt(l.pricePerPixel) * rectArea(bought)), datum: txOutRefTag(listingU.utxoRef) },
            { address: userAddr, value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(bought), 1n]])) },
        ],
        // CIP-25 artwork for every deed this carve mints (bought + complements)
        metadata: deedCip25(config.ownershipPolicy, [bought, ...comps]),
        changeAddress: userAddr,
    }));
}

// ---- chainable acquire building blocks (used by buildAcquireTxs) -----------
type Piece = { rect: Rect; utxo: UTxO };

/** full buy of a whole listing, deed → outAddr, chained (funding threaded) */
async function buildOneBuy(outAddr: Address, l: MarketListing, listingU: UTxO, f: UTxO[]): Promise<Tx> {
    const { refK } = await refScripts();
    return (await txBuilder()).build({
        inputs: [{ utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(l.rect) } }, ...f],
        outputs: [
            { address: Address.fromString(l.seller), value: Value.lovelaces(BigInt(l.priceTotal)), datum: txOutRefTag(listingU.utxoRef) },
            { address: outAddr, value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(l.rect), 1n]])) },
        ],
        changeAddress: outAddr,
    });
}

/** partial buy of `bought` ⊂ listing: carve out the sub-rect, relist the
 *  guillotine complements on the same terms, deed → outAddr, chained */
async function buildOnePartialBuy(outAddr: Address, l: MarketListing, bought: Rect, listingU: UTxO, f: UTxO[]): Promise<Tx> {
    const parent = l.rect;
    const comps = carveComplements(parent, bought);
    const { refO, refK } = await refScripts();
    const mintEntries: [Uint8Array, bigint][] = [
        [rectName(parent), -1n], [rectName(bought), 1n],
        ...comps.map((c): [Uint8Array, bigint] => [rectName(c), 1n]),
    ];
    return (await txBuilder()).build({
        inputs: [{ utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(parent, bought) } }, ...f],
        mints: [{ value: tokens(config.ownershipPolicy, mintEntries), script: { ref: refO, redeemer: oMintCarve(parent, bought) } }],
        outputs: [
            ...comps.map((c) => ({
                address: Address.fromString(config.marketplaceAddress),
                value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(c), 1n]])),
                datum: asConstr(listingU.resolved.datum),   // same seller + price
            })),
            { address: Address.fromString(l.seller), value: Value.lovelaces(BigInt(l.pricePerPixel) * rectArea(bought)), datum: txOutRefTag(listingU.utxoRef) },
            { address: outAddr, value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(bought), 1n]])) },
        ],
        metadata: deedCip25(config.ownershipPolicy, [bought, ...comps]),
        changeAddress: outAddr,
    });
}

/** merge two edge-adjacent deeds into their union deed, chained */
async function buildOneMerge(outAddr: Address, a: Piece, b: Piece, union: Rect, f: UTxO[]): Promise<Tx> {
    const { refO } = await refScripts();
    return (await txBuilder()).build({
        inputs: [a.utxo, b.utxo, ...f],
        mints: [{
            value: tokens(config.ownershipPolicy, [[rectName(a.rect), -1n], [rectName(b.rect), -1n], [rectName(union), 1n]]),
            script: { ref: refO, redeemer: oMintMerge(a.rect, b.rect) },
        }],
        outputs: [{ address: outAddr, value: Value.add(Value.lovelaces(2_000_000n), tokens(config.ownershipPolicy, [[rectName(union), 1n]])) }],
        metadata: deedCip25(config.ownershipPolicy, [union]),
        changeAddress: outAddr,
    });
}

/**
 * Acquire a WHOLE selection that may span FREE + LISTED areas: claim the free
 * sub-rects and partial-buy the listed sub-rects in one chained batch, leaving
 * the wallet owning the entire rectangle. If `canMerge` (the wallet can sign the
 * whole chain in one prompt), the pieces are then greedily merged into as few
 * deeds as the geometry allows — ideally one. If a `sprite` is placed it is
 * painted (referencing all the pieces) and committed in the same batch.
 *
 * Throws if any part of the selection is claimed-but-NOT-listed (unavailable).
 */
export async function buildAcquireTxs(
    api: WalletApi, address: string, rect: Rect,
    listings: MarketListing[], sprite: PlacedSprite | undefined, canMerge: boolean,
): Promise<string[]> {
    if (!rectValid(rect)) throw new Error("invalid rect");
    const userAddr = Address.fromString(address);
    const ownerAddr = Address.fromString(config.protocolOwnerAddress);
    const isOwner = userAddr.paymentCreds.hash.toString() === ownerAddr.paymentCreds.hash.toString();
    const outAddr = isOwner ? ownerAddr : userAddr;

    // tile the selection into free + listed rectangles (they never overlap, so
    // exact area coverage ⇒ a clean tiling; any shortfall = unavailable pixels)
    const nodes = await freeNodes();
    const freeParts = nodes
        .map((node) => ({ node, part: rectIntersect(node.rect, rect) }))
        .filter((p): p is { node: FreeNode; part: Rect } => p.part !== null);
    const listedParts = listings
        .map((l) => ({ l, part: rectIntersect(l.rect, rect) }))
        .filter((p): p is { l: MarketListing; part: Rect } => p.part !== null);
    const covered = [...freeParts, ...listedParts].reduce((s, p) => s + rectArea(p.part), 0n);
    if (covered !== rectArea(rect))
        throw new Error("part of your selection is owned and not for sale — trim it to the green (free) and gold (listed) areas");

    const { refO } = await refScripts();
    const { utxo: priceRef, pricePerPixel } = await priceConfig();
    const editGroups = sprite ? spriteLeafGroups(sprite) : [];

    // funding: claim payments + buy payments + relisted-comp/deed min-adas + fees
    let target = 0n;
    for (const { node, part } of freeParts)
        target += (isOwner ? 0n : rectArea(part) * pricePerPixel)
            + BigInt(carveComplements(node.rect, part).length) * 3_000_000n + 2_000_000n;
    for (const { l, part } of listedParts)
        target += BigInt(l.pricePerPixel) * rectArea(part)
            + BigInt(carveComplements(l.rect, part).length + 1) * MIN_LISTING_LOVELACE;
    target += BigInt(editGroups.length + freeParts.length + listedParts.length + 2) * 2_000_000n; // fee headroom

    let f = await walletFunding(api, [], target);
    const txs: Tx[] = [];
    let pieces: Piece[] = [];

    for (const { node, part } of freeParts) {
        const price = isOwner ? 0n : rectArea(part) * pricePerPixel;
        const tx = await buildOneClaim(outAddr, isOwner, node, part, f, refO, price, priceRef);
        txs.push(tx); pieces.push({ rect: part, utxo: deedUtxoOf(tx, part, outAddr) });
        f = [chainChange(tx, outAddr)];
    }
    for (const { l, part } of listedParts) {
        const listingU = await marketUtxo(l.utxoRef);
        const tx = rectArea(part) === rectArea(l.rect)
            ? await buildOneBuy(outAddr, l, listingU, f)
            : await buildOnePartialBuy(outAddr, l, part, listingU, f);
        txs.push(tx); pieces.push({ rect: part, utxo: deedUtxoOf(tx, part, outAddr) });
        f = [chainChange(tx, outAddr)];
    }

    // greedily merge into fewer deeds — only when the wallet can bulk-sign (each
    // merge spends mempool deed outputs, unsignable one-at-a-time)
    if (canMerge) {
        let progress = true;
        while (progress && pieces.length > 1) {
            progress = false;
            for (let i = 0; i < pieces.length && !progress; i++)
                for (let j = i + 1; j < pieces.length; j++) {
                    const union = rectUnionIfMergeable(pieces[i].rect, pieces[j].rect);
                    if (!union) continue;
                    const tx = await buildOneMerge(outAddr, pieces[i], pieces[j], union, f);
                    txs.push(tx); f = [chainChange(tx, outAddr)];
                    const merged = { rect: union, utxo: deedUtxoOf(tx, union, outAddr) };
                    pieces = pieces.filter((_, k) => k !== i && k !== j).concat(merged);
                    progress = true; break;
                }
        }
    }

    // paint the selection across whatever deeds we ended up with, then commit
    if (editGroups.length > 0) {
        const plots: Plot[] = pieces.map((p) => ({ rect: p.rect, name: rectNameStr(p.rect), utxo: p.utxo }));
        const edited: EditedLeaf[] = [];
        for (const g of editGroups) {
            const res = await buildOneEdit(outAddr, plots, g.leafIdx, g.pixels, f);
            if (!res) continue;
            txs.push(res.tx); edited.push({ leafIdx: g.leafIdx, newCid: res.newCid, leafUtxo: leafOutputOf(res.tx) });
            f = [chainChange(res.tx, outAddr)];
        }
        const { txs: commitTxs } = await buildCommitTxs(edited, f, outAddr);
        txs.push(...commitTxs);
    }

    return txs.map(toHex);
}

export async function buildMarketCancelTx(api: WalletApi, address: string, utxoRef: string): Promise<string> {
    const userAddr = Address.fromString(address);
    const orderU = await marketUtxo(utxoRef);
    const d = asConstr(orderU.resolved.datum);
    const owner = Address.fromData(d.fields[0] as Parameters<typeof Address.fromData>[0], "testnet");
    if (owner.paymentCreds.hash.toString() !== userAddr.paymentCreds.hash.toString())
        throw new Error("only the order's owner can cancel it");
    const redeemer = Number(d.constr) === 0 ? mListingCancel() : mRequestCancel();
    const { refK } = await refScripts();
    const f = await walletFunding(api);
    return toHex(await (await txBuilder()).build({
        inputs: [
            { utxo: orderU, referenceScript: { refUtxo: refK, datum: "inline", redeemer } },
            ...f,
        ],
        requiredSigners: [userAddr.paymentCreds.hash],
        outputs: [{ address: userAddr, value: orderU.resolved.value }],
        changeAddress: userAddr,
    }));
}

export async function buildMarketRequestTx(
    api: WalletApi, address: string, rect: Rect, offerLovelace: bigint, existingDeeds: string[],
): Promise<string> {
    if (!rectValid(rect)) throw new Error("invalid rect");
    if (offerLovelace < MIN_LISTING_LOVELACE) throw new Error("offer below min-ada");
    const name = rectNameStr(rect);
    if (!existingDeeds.includes(name))
        throw new Error(`no deed "${name}" exists on-chain — nobody could fill this request`);
    const userAddr = Address.fromString(address);
    const f = await walletFunding(api, [], offerLovelace);
    return toHex(await (await txBuilder()).build({
        inputs: f,
        outputs: [{
            address: Address.fromString(config.marketplaceAddress),
            value: Value.lovelaces(offerLovelace),
            datum: requestDatum(userAddr, rect),
        }],
        changeAddress: userAddr,
    }));
}

export async function buildMarketFillTx(api: WalletApi, address: string, r: MarketRequest): Promise<string> {
    const userAddr = Address.fromString(address);
    const requestU = await marketUtxo(r.utxoRef);
    const deedU = await walletDeed(api, r.name);
    const { refK } = await refScripts();
    const f = await walletFunding(api, [deedU.utxoRef.toString()], MIN_LISTING_LOVELACE);
    return toHex(await (await txBuilder()).build({
        inputs: [
            { utxo: requestU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
            deedU,
            ...f,
        ],
        outputs: [
            { address: Address.fromString(r.requester), value: Value.add(Value.lovelaces(MIN_LISTING_LOVELACE), tokens(config.ownershipPolicy, [[rectName(r.rect), 1n]])) },
        ],
        changeAddress: userAddr,
    }));
}
