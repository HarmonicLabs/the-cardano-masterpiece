// ===========================================================================
//  Mixed ACQUIRE + MERGE on the LOCAL DEVNET — validates the website's
//  buildAcquireTxs composition on a real node: a selection that spans a LISTED
//  plot and FREE space is acquired (partial-buy the listed part + claim the
//  free part) and then MERGED into a single deed.
//
//  Scenario: seller (= protocolOwner) claims D=(0,0)-(100,100) and lists it.
//  Buyer wants R=(0,0)-(60,150): the (0,0)-(60,100) part is partial-bought from
//  the listing; the (0,100)-(60,150) part is claimed from free space; the two
//  are then merged into (0,0)-(60,150).
//
//  Run (devnet up):  npx tsx acquire-merge.ts
// ===========================================================================
import { Value, Hash28, dataToCbor, type Data, type UTxO } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, pureAdaUtxo, type Wallet,
} from "./lib.ts";
import {
    ownershipContract, marketplaceContract, lockContract, lockedDatum,
    freeDatum, listingDatum, lovelacePerPixelDatum,
    oMintInit, oMintFree, oMintCarve, oMintMerge, oClaim, mPartialBuy,
    carveComplements, rectName, rectArea, txOutRefData,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, MIN_LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const MIN_LISTING = ADA(2);
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();
const dh = (d: Data): string => dataToCbor(d).toString();
const udh = (u: UTxO): string | undefined => u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;
const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };

step("0. wallets + funding");
const seller: Wallet = ensureWallet(`acq-seller-${Date.now()}`);
const buyer: Wallet = ensureWallet(`acq-buyer-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: seller.address, lovelace: ADA(10) },
    { address: seller.address, lovelace: ADA(50) },
    { address: seller.address, lovelace: ADA(2000) },
    { address: seller.address, lovelace: ADA(70) },
    { address: buyer.address, lovelace: ADA(10) },
    { address: buyer.address, lovelace: ADA(2000) },
], "fund-acq");
awaitTxAtAddr(buyer.address, fundTx);
const sU = queryUtxos(seller.address);
const sColl = sU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = sU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
const sFunds = sU.find((u) => u.resolved.value.lovelaces === ADA(2000))!;

const own = ownershipContract(seller.address, genesisU.utxoRef);   // protocolOwner = seller
const market = marketplaceContract(own.hash.toBuffer());
const lock = lockContract();
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceNft = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);

step("0b. deploy reference scripts");
const deployHash = await signSubmitAwait({
    inputs: [sU.find((u) => u.resolved.value.lovelaces === ADA(70))!],
    outputs: [
        { address: lock.address, value: Value.lovelaces(ADA(35)), refScript: own.script, datum: lockedDatum() },
        { address: lock.address, value: Value.lovelaces(ADA(25)), refScript: market.script, datum: lockedDatum() },
    ],
    changeAddress: seller.address,
}, seller, "deploy-refs", lock.address.toString());
const atLock = queryUtxos(lock.address);
const refO = atLock.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 0)!;
const refK = atLock.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 1)!;
const noRefs = (u: { utxoRef: { toString(): string } }) => u.utxoRef.toString() !== refO.utxoRef.toString() && u.utxoRef.toString() !== refK.utxoRef.toString();

step("1. ownership init");
{
    const gIdx = sortedRefIndex([genesisU.utxoRef, sFunds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, sFunds],
        collaterals: [sColl],
        mints: [{ value: Value.add(marker(1n), priceNft(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceNft(1n)), datum: lovelacePerPixelDatum(MIN_LOVELACE_PER_PIXEL) },
        ],
        changeAddress: seller.address,
    }, seller, "ownership-init", own.address);
}
const priceCfg = () => findUtxoWithAsset(queryUtxos(own.address), own.policyHex, PRICE_NFT_NAME)!;
const freeNodeOf = (r: Rect) => queryUtxos(own.address).find((u) => findUtxoWithAsset([u], own.policyHex, FREE_TOKEN_NAME) && udh(u) === dh(freeDatum(r)))!;
const sFund = (min: bigint) => pureAdaUtxo(queryUtxos(seller.address).filter(noRefs).filter(notRef(sColl)), min)!;
const bFund = (min: bigint) => { const bu = queryUtxos(buyer.address); const c = bu.find((u) => u.resolved.value.lovelaces === ADA(10))!; return { coll: c, funds: pureAdaUtxo(bu.filter(notRef(c)), min)! }; };

step("2. seller claims D=(0,0)-(100,100) and lists it at 1 ADA/px");
const D: Rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
const PPP = ADA(1);
{
    const comps = carveComplements(CANVAS, D);   // right {100,0,1008,100}, bottom {0,100,1008,1008}
    await signSubmitAwait({
        inputs: [{ utxo: freeNodeOf(CANVAS), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(D) } }, sFund(ADA(200))],
        readonlyRefInputs: [priceCfg()],
        collaterals: [sColl],
        mints: [{ value: Value.add(deed(D, 1n), marker(BigInt(comps.length - 1))), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: seller.address, value: Value.lovelaces(rectArea(D) * MIN_LOVELACE_PER_PIXEL) },
            { address: seller.address, value: withAda(ADA(2), deed(D, 1n)) },
        ],
        changeAddress: seller.address,
    }, seller, "claim-D", seller.address);
    const deedU = findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(D))!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noRefs).filter(notRef(sColl)).filter((u) => u !== deedU), ADA(5))!;
    await signSubmitAwait({
        inputs: [deedU, funds],
        outputs: [{ address: market.address, value: withAda(ADA(2), deed(D, 1n)), datum: listingDatum(seller.address, PPP) }],
        changeAddress: seller.address,
    }, seller, "list-D", market.address);
    console.log("  D claimed + listed ✓");
}

// ---------------------------------------------------------------------------
// Buyer acquires R=(0,0)-(60,150): partial-buy (0,0)-(60,100) from D + claim
// (0,100)-(60,150) from the bottom free node, then merge into (0,0)-(60,150).
// ---------------------------------------------------------------------------
const bought: Rect = { x0: 0, y0: 0, x1: 60, y1: 100 };     // ⊂ D (listed)
const freePart: Rect = { x0: 0, y0: 100, x1: 60, y1: 150 }; // ⊂ bottom free node
const bottomFree: Rect = { x0: 0, y0: 100, x1: 1008, y1: 1008 };
const R: Rect = { x0: 0, y0: 0, x1: 60, y1: 150 };

step("3. buyer PARTIAL-BUYS (0,0)-(60,100) from the listing");
{
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(D))!;
    const comps = carveComplements(D, bought);   // relisted complements
    const { coll, funds } = bFund(ADA(60));
    await signSubmitAwait({
        inputs: [{ utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(D, bought) } }, funds],
        collaterals: [coll],
        mints: [{ value: [deed(D, -1n), deed(bought, 1n), ...comps.map((c) => deed(c, 1n))].reduce((a, b) => Value.add(a, b)), script: { ref: refO, redeemer: oMintCarve(D, bought) } }],
        outputs: [
            ...comps.map((c) => ({ address: market.address, value: withAda(MIN_LISTING, deed(c, 1n)), datum: listingDatum(seller.address, PPP) })),
            { address: seller.address, value: Value.lovelaces(PPP * rectArea(bought)), datum: txOutRefData(listingU.utxoRef) },
            { address: buyer.address, value: withAda(MIN_LISTING, deed(bought, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "partialbuy", buyer.address);
    assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(bought)), "buyer holds the bought piece");
    console.log("  bought (0,0)-(60,100) ✓");
}

step("4. buyer CLAIMS (0,100)-(60,150) from free space");
{
    const comps = carveComplements(bottomFree, freePart);
    const { coll, funds } = bFund(ADA(200));
    await signSubmitAwait({
        inputs: [{ utxo: freeNodeOf(bottomFree), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(freePart) } }, funds],
        readonlyRefInputs: [priceCfg()],
        collaterals: [coll],
        mints: [{ value: Value.add(deed(freePart, 1n), marker(BigInt(comps.length - 1))), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: seller.address, value: Value.lovelaces(rectArea(freePart) * MIN_LOVELACE_PER_PIXEL) }, // pays protocolOwner (=seller)
            { address: buyer.address, value: withAda(ADA(2), deed(freePart, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "claim-free", buyer.address);
    assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(freePart)), "buyer holds the free piece");
    console.log("  claimed (0,100)-(60,150) ✓");
}

step("5. buyer MERGES the two pieces into (0,0)-(60,150)");
{
    const aU = findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(bought))!;
    const bU = findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(freePart))!;
    const { coll, funds } = bFund(ADA(5));
    await signSubmitAwait({
        inputs: [aU, bU, funds],
        collaterals: [coll],
        mints: [{ value: [deed(bought, -1n), deed(freePart, -1n), deed(R, 1n)].reduce((a, b) => Value.add(a, b)), script: { ref: refO, redeemer: oMintMerge(bought, freePart) } }],
        outputs: [{ address: buyer.address, value: withAda(ADA(2), deed(R, 1n)) }],
        changeAddress: buyer.address,
    }, buyer, "merge", buyer.address);
    const after = queryUtxos(buyer.address);
    assert(findUtxoWithAsset(after, own.policyHex, rectName(R)), "buyer holds the merged (0,0)-(60,150) deed");
    assert(!findUtxoWithAsset(after, own.policyHex, rectName(bought)), "bought piece burned");
    assert(!findUtxoWithAsset(after, own.policyHex, rectName(freePart)), "free piece burned");
    console.log("  merged into a SINGLE deed (0,0)-(60,150) ✓");
}

console.log("\nMIXED ACQUIRE + MERGE — ALL CHECKS PASSED ✓ (partial-buy + claim + merge → one NFT)");
