// ===========================================================================
//  Marketplace contract probe — fully OFFLINE tx-level tests.
//  Fabricates utxos and builds real txs with buildooor: the builder evaluates
//  the scripts during build (plutus-machine), so a successful build == the
//  validators accepted, and a failed build == one of them rejected.
//  Only the protocol parameters come from the network.
//
//  The partial-buy scenarios COMPOSE two real validators in one tx: the
//  marketplace spend AND the ownership `split` mint (probe-local ownership
//  instance, so the deed policy is genuinely enforceable here).
// ===========================================================================
import {
    Address, Credential, PrivateKey, Value, Hash28, TxBuilder, TxOut, TxOutRef, UTxO, Script,
    DataConstr, DataI, defaultPreprodGenesisInfos, type ITxBuildArgs,
} from "@harmoniclabs/buildooor";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";
import {
    ownershipContract, marketplaceContract, listingDatum, requestDatum,
    mBuy, mPartialBuy, mListingCancel, mFill, mRequestCancel, mRecover, oMintCarve, carveComplements,
    rectName, txOutRefData, type Rect,
} from "./contracts.ts";
import { hexToBytes } from "./lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const area = (r: Rect): bigint => BigInt((r.x1 - r.x0) * (r.y1 - r.y0));

// ---- actors (deterministic throwaway keys) --------------------------------
const key = (fill: number): PrivateKey => new PrivateKey(new Uint8Array(32).fill(fill));
const addrOf = (k: PrivateKey): Address => Address.testnet(Credential.keyHash(k.derivePublicKey().hash));
const seller = addrOf(key(7));
const sellerPkh = key(7).derivePublicKey().hash;
const buyer = addrOf(key(8));
const requester = addrOf(key(9));
const requesterPkh = key(9).derivePublicKey().hash;

// ---- contracts ------------------------------------------------------------
// probe-local ownership instance: its `split` mint really runs in the
// partial-buy txs below, enforcing cut geometry + exact mint
const own = ownershipContract(addrOf(key(10)), new TxOutRef({ id: "00".repeat(32), index: 0 }));
const market = marketplaceContract(hexToBytes(own.policyHex));
console.log("ownership policy  :", own.policyHex);
console.log("marketplace policy:", market.policyHex);

const deedRect: Rect = { x0: 10, y0: 10, x1: 20, y1: 20 }; // 100 px
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);

// ---- fabricated utxos -----------------------------------------------------
let refN = 0;
const fakeRef = (): TxOutRef => new TxOutRef({ id: (++refN).toString(16).padStart(64, "0"), index: 0 });
const u = (address: Address, value: Value, datum?: DataConstr, refScript?: Script): UTxO =>
    new UTxO({ utxoRef: fakeRef(), resolved: new TxOut({ address, value, datum, refScript }) });

// ALWAYS use reference scripts (matches production; fabricated utxos here)
const refO = u(addrOf(key(10)), Value.lovelaces(ADA(40)), undefined, own.script);
const refK = u(addrOf(key(10)), Value.lovelaces(ADA(25)), undefined, market.script);

const PPP = ADA(1); // price per pixel
const listingU = u(market.address, Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)), listingDatum(seller, PPP));
const offerU = u(market.address, Value.lovelaces(ADA(50)), requestDatum(requester, deedRect));
const garbageU = u(market.address, Value.lovelaces(ADA(5)), new DataConstr(4, [new DataI(42)]));

const api = new BlockfrostPluts({ customBackend: (process.env.BLOCKFROST_URL ?? "https://blockfrost-preprod.onchainapps.io"), network: "preprod" });
const txb = new TxBuilder(await api.getProtocolParameters(), defaultPreprodGenesisInfos);

async function expectOk(name: string, args: ITxBuildArgs): Promise<void> {
    await txb.build(args); // build() is async — the validators run during it
    console.log(`  ${name} ✓`);
}
async function expectFail(name: string, args: ITxBuildArgs): Promise<void> {
    try { await txb.build(args); }
    catch { console.log(`  ${name} (rejected as expected) ✓`); return; }
    throw new Error(`${name}: expected a validator to REJECT, but the tx built`);
}

// ---- Listing.buy ----------------------------------------------------------
const FULL_PRICE = PPP * area(deedRect); // 100 ada
const buyerFunds = u(buyer, Value.lovelaces(ADA(500)));
const buyerColl = u(buyer, Value.lovelaces(ADA(10)));
await expectOk("Listing.buy", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(deedRect) } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: seller, value: Value.lovelaces(FULL_PRICE), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});
await expectFail("Listing.buy with no seller payment at all", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(deedRect) } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});
await expectFail("Listing.buy without the listing-ref tag", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(deedRect) } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: seller, value: Value.lovelaces(FULL_PRICE) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});
await expectFail("Listing.buy underpaying", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(deedRect) } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: seller, value: Value.lovelaces(FULL_PRICE - 1n), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});
await expectFail("Listing.buy naming a smaller rect to pay less", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy({ x0: 10, y0: 10, x1: 11, y1: 11 }) } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: seller, value: Value.lovelaces(PPP), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});

// ---- Listing.partialBuy (carve-based: ANY sub-rect in one tx) -------------
// interior rect: carve mints 4 complements, every one must be relisted
const inner: Rect = { x0: 12, y0: 13, x1: 17, y1: 18 }; // 25 px
const innerComps = carveComplements(deedRect, inner);
const INNER_PRICE = PPP * area(inner); // 25 ada
const carveMint = (parent: Rect, target: Rect): Value =>
    [deed(parent, -1n), deed(target, 1n), ...carveComplements(parent, target).map((c) => deed(c, 1n))]
        .reduce((a, b) => Value.add(a, b));
const relistOut = (c: Rect) => ({
    address: market.address,
    value: Value.add(Value.lovelaces(ADA(2)), deed(c, 1n)),
    datum: listingDatum(seller, PPP),
});
const partialArgs = (over: Partial<ITxBuildArgs>): ITxBuildArgs => ({
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, inner) } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    mints: [{
        value: carveMint(deedRect, inner),
        script: { ref: refO, redeemer: oMintCarve(deedRect, inner) },
    }],
    outputs: [
        ...innerComps.map(relistOut),
        { address: seller, value: Value.lovelaces(INNER_PRICE), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(inner, 1n)) },
    ],
    changeAddress: buyer,
    ...over,
});
await expectOk("Listing.partialBuy interior rect (carve composes in-tx, 4 complements relisted)", partialArgs({}));
// edge slab: only 1 complement — the old split-style purchase, via carve
const topHalf: Rect = { x0: 10, y0: 10, x1: 20, y1: 15 };    // 50 px
const bottomHalf: Rect = { x0: 10, y0: 15, x1: 20, y1: 20 }; // 50 px
await expectOk("Listing.partialBuy edge slab (1 complement)", partialArgs({
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, topHalf) } },
        buyerFunds,
    ],
    mints: [{
        value: carveMint(deedRect, topHalf),
        script: { ref: refO, redeemer: oMintCarve(deedRect, topHalf) },
    }],
    outputs: [
        relistOut(bottomHalf),
        { address: seller, value: Value.lovelaces(PPP * area(topHalf)), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(topHalf, 1n)) },
    ],
}));
await expectFail("Listing.partialBuy stealing a complement (3 of 4 relisted)", partialArgs({
    outputs: [
        ...innerComps.slice(0, 3).map(relistOut),
        { address: seller, value: Value.lovelaces(INNER_PRICE), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(4)), Value.add(deed(inner, 1n), deed(innerComps[3], 1n))) },
    ],
}));
await expectFail("Listing.partialBuy relisting a complement at a lower price", partialArgs({
    outputs: [
        ...innerComps.slice(0, 3).map(relistOut),
        { address: market.address, value: Value.add(Value.lovelaces(ADA(2)), deed(innerComps[3], 1n)), datum: listingDatum(seller, 1n) },
        { address: seller, value: Value.lovelaces(INNER_PRICE), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(inner, 1n)) },
    ],
}));
await expectFail("Listing.partialBuy relisting a complement below the ada floor", partialArgs({
    outputs: [
        ...innerComps.slice(0, 3).map(relistOut),
        { address: market.address, value: Value.add(Value.lovelaces(1_500_000n), deed(innerComps[3], 1n)), datum: listingDatum(seller, PPP) },
        { address: seller, value: Value.lovelaces(INNER_PRICE), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(inner, 1n)) },
    ],
}));
await expectFail("Listing.partialBuy underpaying the bought area", partialArgs({
    outputs: [
        ...innerComps.map(relistOut),
        { address: seller, value: Value.lovelaces(INNER_PRICE - 1n), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(inner, 1n)) },
    ],
}));
await expectFail("Listing.partialBuy carving a rect outside the parent (ownership rejects)", (() => {
    const outside: Rect = { x0: 15, y0: 15, x1: 25, y1: 25 };
    return partialArgs({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, outside) } },
            buyerFunds,
        ],
        mints: [{
            value: carveMint(deedRect, outside),
            script: { ref: refO, redeemer: oMintCarve(deedRect, outside) },
        }],
        outputs: [
            ...carveComplements(deedRect, outside).map(relistOut),
            { address: seller, value: Value.lovelaces(PPP * area(outside)), datum: txOutRefData(listingU.utxoRef) },
            { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(outside, 1n)) },
        ],
    });
})());
await expectFail("Listing.partialBuy carving the whole parent (ownership rejects, k=0)", partialArgs({
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, deedRect) } },
        buyerFunds,
    ],
    mints: [{
        value: Value.add(deed(deedRect, -1n), deed(deedRect, 1n)),
        script: { ref: refO, redeemer: oMintCarve(deedRect, deedRect) },
    }],
    outputs: [
        { address: seller, value: Value.lovelaces(FULL_PRICE), datum: txOutRefData(listingU.utxoRef) },
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
}));

// ---- ownership carve standalone (wallet-held deed, no marketplace) --------
const walletDeed = u(buyer, Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)));
const corner: Rect = { x0: 10, y0: 10, x1: 15, y1: 15 };
await expectOk("ownership.carve on a wallet-held deed (2 complements)", {
    inputs: [walletDeed, buyerFunds],
    collaterals: [buyerColl],
    mints: [{
        value: carveMint(deedRect, corner),
        script: { ref: refO, redeemer: oMintCarve(deedRect, corner) },
    }],
    outputs: [
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(corner, 1n)) },
        ...carveComplements(deedRect, corner).map((c) => ({ address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(c, 1n)) })),
    ],
    changeAddress: buyer,
});

// ---- Listing.cancel -------------------------------------------------------
const sellerFunds = u(seller, Value.lovelaces(ADA(20)));
const sellerColl = u(seller, Value.lovelaces(ADA(10)));
await expectOk("Listing.cancel", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mListingCancel() } },
        sellerFunds,
    ],
    collaterals: [sellerColl],
    requiredSigners: [sellerPkh],
    changeAddress: seller,
});
await expectFail("Listing.cancel unsigned", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mListingCancel() } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    changeAddress: buyer,
});

// ---- Request.fill ---------------------------------------------------------
const fillerDeed = u(buyer, Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)));
await expectOk("Request.fill", {
    inputs: [
        { utxo: offerU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
        fillerDeed,
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: requester, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});
await expectFail("Request.fill keeping the deed", {
    inputs: [
        { utxo: offerU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
        fillerDeed,
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});

// ---- Request.cancel -------------------------------------------------------
const reqFunds = u(requester, Value.lovelaces(ADA(20)));
const reqColl = u(requester, Value.lovelaces(ADA(10)));
await expectOk("Request.cancel", {
    inputs: [
        { utxo: offerU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRequestCancel() } },
        reqFunds,
    ],
    collaterals: [reqColl],
    requiredSigners: [requesterPkh],
    changeAddress: requester,
});

// ---- fallback recover -----------------------------------------------------
// datum-less utxos reach the bare fallback and are sweepable
const nodatumU = u(market.address, Value.lovelaces(ADA(5)));
await expectOk("recover (no datum)", {
    inputs: [
        { utxo: nodatumU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRecover() } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    changeAddress: buyer,
});
// ill-formed constr datums reach the fallback too (BUG 20, fixed)
await expectOk("recover (unknown-constr datum) — BUG 20 fixed", {
    inputs: [
        { utxo: garbageU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRecover() } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    changeAddress: buyer,
});

// ---- ADVERSARIAL: `recover` must be UNREACHABLE for well-formed datums -----
// The fallback runs no checks, so if a genuine Listing / Request UTxO could be
// spent through it, ANY passer-by could sweep a listed deed or a live offer.
// The datum dispatch must route Constr-0 datums to the Listing methods and
// Constr-1 datums to the Request methods, NEVER to the bare fallback. Each of
// these tries to steal via `recover` and MUST be rejected.
//
// `mRecover()` is Constr 0 [] — byte-identical to `mFill()` and to what a
// Listing's index-0 method (`buy`) would receive with no arguments. So these
// double as: "does the fallback shadow a real state method?"

// (a) a genuine Listing (holds the deed) swept for free via `recover`
await expectFail("recover on a well-formed Listing (steal listed deed)", {
    inputs: [
        { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRecover() } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    // no seller payment, no ref tag — a pure theft attempt
    outputs: [
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});

// (b) a genuine Request (holds the offer) swept for free via `recover`.
// Constr-1 datum + Constr-0 redeemer routes to Request.fill — which demands
// the deed be delivered to the requester; here it is NOT, so it must reject.
await expectFail("recover on a well-formed Request (steal the offer, no deed delivered)", {
    inputs: [
        { utxo: offerU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRecover() } },
        buyerFunds,
    ],
    collaterals: [buyerColl],
    // buyer just takes the 50 ada offer, delivers nothing
    changeAddress: buyer,
});

// (c) same Request, but the attacker even holds the deed — still no delivery
// output. Confirms rejection is about the missing delivery, not missing token.
await expectFail("recover on a well-formed Request (attacker holds deed, still no delivery)", {
    inputs: [
        { utxo: offerU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRecover() } },
        u(buyer, Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n))),
        buyerFunds,
    ],
    collaterals: [buyerColl],
    outputs: [
        // deed kept by the attacker instead of delivered to `requester`
        { address: buyer, value: Value.add(Value.lovelaces(ADA(2)), deed(deedRect, 1n)) },
    ],
    changeAddress: buyer,
});

assert(true);
console.log("\nMARKETPLACE PROBE PASSED ✓ (25 scenarios, incl. adversarial recover-on-valid-datum)");
