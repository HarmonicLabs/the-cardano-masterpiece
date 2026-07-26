// ===========================================================================
//  Marketplace end-to-end on the LOCAL DEVNET — real node phase-2 validation.
//
//  Full lifecycle, all scripts INLINE (no reference deploys needed):
//    0. fund seller + buyer from genesis
//    1. ownership init            (fresh instance, protocolOwner = seller)
//    2. seller claims a deed      (10,10)-(20,20), pays 5 ada/px to itself
//    3. seller lists it           1 ada per pixel
//    4. buyer partialBuy INNER    (12,13)-(17,18): carve composes ON-CHAIN,
//                                 4 complements relisted, buyer pays 25 ada
//    5. buyer full-buys the top complement listing
//    6. seller cancels the bottom complement listing (takes the deed back)
//    7. buyer requests that deed for 30 ada; seller fills the request
//    8. recover a garbage-datum utxo from the marketplace address
// ===========================================================================
import { Value, Hash28, DataConstr, DataI, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, type Wallet,
} from "./lib.ts";
import {
    ownershipContract, marketplaceContract, lockContract, lockedDatum, freeDatum, listingDatum, requestDatum,
    oMintInit, oMintFree, oMintCarve, oMintMerge, oClaim, mBuy, mPartialBuy, mListingCancel,
    mFill, mRequestCancel, mRecover, carveComplements, rectName, rectArea, txOutRefData,
    FREE_TOKEN_NAME, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();

// ---------------------------------------------------------------------------
step("0. wallets + funding");
const seller: Wallet = ensureWallet(`mkt-seller-${Date.now()}`);
const buyer: Wallet = ensureWallet(`mkt-buyer-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: seller.address, lovelace: ADA(10) },   // collateral
    { address: seller.address, lovelace: ADA(50) },   // ownership genesis utxo
    { address: seller.address, lovelace: ADA(600) },  // funds
    { address: seller.address, lovelace: ADA(70) },   // ref-script deploys
    { address: buyer.address, lovelace: ADA(10) },    // collateral
    { address: buyer.address, lovelace: ADA(200) },   // funds
], "fund-mkt");
awaitTxAtAddr(buyer.address, fundTx);
const sellerU = queryUtxos(seller.address);
const sellerColl = sellerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = sellerU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
const sellerFunds = sellerU.find((u) => u.resolved.value.lovelaces === ADA(600))!;
console.log("  seller:", seller.address.toString());
console.log("  buyer :", buyer.address.toString());

// ---------------------------------------------------------------------------
// contracts: fresh ownership instance + marketplace over its policy
// ---------------------------------------------------------------------------
const own = ownershipContract(seller.address, genesisU.utxoRef);
const market = marketplaceContract(own.hash.toBuffer());
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  ownership  :", own.policyHex);
console.log("  marketplace:", market.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy reference scripts (ALWAYS use refs, as in production)");
const deployFunds = sellerU.find((u) => u.resolved.value.lovelaces === ADA(70))!;
const lock = lockContract();
const deployHash = await signSubmitAwait({
    inputs: [deployFunds],
    outputs: [
        // parked at the Lock address: permanently unspendable
        { address: lock.address, value: Value.lovelaces(ADA(35)), refScript: own.script, datum: lockedDatum() },
        { address: lock.address, value: Value.lovelaces(ADA(25)), refScript: market.script, datum: lockedDatum() },
    ],
    changeAddress: seller.address,
}, seller, "deploy-refs", lock.address.toString());
const afterDeploy = queryUtxos(lock.address);
const refO = afterDeploy.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 0)!;
const refK = afterDeploy.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 1)!;
// NEVER pick the deployed ref-script utxos as funding: spending one destroys
// the deployment AND incurs a ref-script fee the cli-parsed utxo (which drops
// the refScript field) cannot account for
const noDeployRefs = (u: { utxoRef: { toString(): string } }): boolean =>
    u.utxoRef.toString() !== refO.utxoRef.toString() && u.utxoRef.toString() !== refK.utxoRef.toString();

// ---------------------------------------------------------------------------
step("1. ownership init");
{
    const gIdx = sortedRefIndex([genesisU.utxoRef, sellerFunds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, sellerFunds],
        collaterals: [sellerColl],
        mints: [{
            value: marker(1n),
            script: { ref: refO, redeemer: oMintInit(gIdx) },
        }],
        outputs: [{
            address: own.address,
            value: withAda(ADA(3), marker(1n)),
            datum: freeDatum({ x0: 0, y0: 0, x1: 1024, y1: 1022 }),
        }],
        changeAddress: seller.address,
    }, seller, "ownership-init", own.address);
}

// ---------------------------------------------------------------------------
step("2. seller claims (10,10)-(20,20)");
const deedRect: Rect = { x0: 10, y0: 10, x1: 20, y1: 20 }; // 100 px -> 500 ada
// guillotine complements of the claim in the whole canvas (top,bottom,left,right)
const claimComps = carveComplements({ x0: 0, y0: 0, x1: 1024, y1: 1022 }, deedRect);
{
    const freeNode = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, FREE_TOKEN_NAME)!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)), ADA(520))!;
    await signSubmitAwait({
        inputs: [
            { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(deedRect) } },
            funds,
        ],
        collaterals: [sellerColl],
        mints: [{
            value: Value.add(deed(deedRect, 1n), marker(BigInt(claimComps.length - 1))),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            ...claimComps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: seller.address, value: Value.lovelaces(ADA(500)) }, // 5 ada/px to protocolOwner (= seller)
            { address: seller.address, value: withAda(ADA(2), deed(deedRect, 1n)) },
        ],
        changeAddress: seller.address,
    }, seller, "claim", seller.address);
    assert(findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(deedRect)), "seller holds the deed");
    console.log("  deed claimed ✓");
}

// ---------------------------------------------------------------------------
step("3. seller lists the deed at 1 ada/px");
const PPP = ADA(1);
{
    const deedU = findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(deedRect))!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)).filter((u) => u !== deedU), ADA(5))!;
    await signSubmitAwait({
        inputs: [deedU, funds],
        outputs: [{
            address: market.address,
            value: withAda(ADA(2), deed(deedRect, 1n)),
            datum: listingDatum(seller.address, PPP),
        }],
        changeAddress: seller.address,
    }, seller, "list", market.address);
    console.log("  listed ✓");
}

// ---------------------------------------------------------------------------
step("4. buyer partialBuy of the inner rect (carve ON-CHAIN)");
const inner: Rect = { x0: 12, y0: 13, x1: 17, y1: 18 }; // 25 px -> 25 ada
const innerComps = carveComplements(deedRect, inner);   // top, bottom, left, right
{
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(deedRect))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(50))!;
    const carveValue = [deed(deedRect, -1n), deed(inner, 1n), ...innerComps.map((c) => deed(c, 1n))]
        .reduce((a, b) => Value.add(a, b));
    await signSubmitAwait({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, inner) } },
            bFunds,
        ],
        collaterals: [bColl],
        mints: [{
            value: carveValue,
            script: { ref: refO, redeemer: oMintCarve(deedRect, inner) },
        }],
        outputs: [
            ...innerComps.map((c) => ({ address: market.address, value: withAda(ADA(2), deed(c, 1n)), datum: listingDatum(seller.address, PPP) })),
            { address: seller.address, value: Value.lovelaces(PPP * rectArea(inner)), datum: txOutRefData(listingU.utxoRef) },
            { address: buyer.address, value: withAda(ADA(2), deed(inner, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "partial-buy", buyer.address);
    assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(inner)), "buyer holds the inner deed");
    const relisted = queryUtxos(market.address);
    for (const c of innerComps)
        assert(findUtxoWithAsset(relisted, own.policyHex, rectName(c)), `complement ${JSON.stringify(c)} relisted`);
    console.log("  inner deed bought, 4 complements relisted ✓");
}

// ---------------------------------------------------------------------------
step("5. buyer full-buys the top complement");
const topComp = innerComps[0]; // {10,10}-{20,13}, 30 px -> 30 ada
{
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(topComp))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(40))!;
    await signSubmitAwait({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(topComp) } },
            bFunds,
        ],
        collaterals: [bColl],
        outputs: [
            { address: seller.address, value: Value.lovelaces(PPP * rectArea(topComp)), datum: txOutRefData(listingU.utxoRef) },
            { address: buyer.address, value: withAda(ADA(2), deed(topComp, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "full-buy", buyer.address);
    assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(topComp)), "buyer holds the top deed");
    console.log("  top complement bought ✓");
}

// ---------------------------------------------------------------------------
step("6. seller cancels the bottom complement listing");
const bottomComp = innerComps[1]; // {10,18}-{20,20}
{
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(bottomComp))!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)), ADA(5))!;
    await signSubmitAwait({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mListingCancel() } },
            funds,
        ],
        collaterals: [sellerColl],
        requiredSigners: [seller.pkh],
        changeAddress: seller.address,
    }, seller, "cancel", seller.address);
    assert(findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(bottomComp)), "seller took the deed back");
    console.log("  listing canceled ✓");
}

// ---------------------------------------------------------------------------
step("7. buyer requests the bottom deed for 30 ada; seller fills");
{
    const buyerU = queryUtxos(buyer.address);
    const bFunds = pureAdaUtxo(buyerU.filter((u) => u.resolved.value.lovelaces !== ADA(10)), ADA(35))!;
    const reqTx = await signSubmitAwait({
        inputs: [bFunds],
        outputs: [{
            address: market.address,
            value: Value.lovelaces(ADA(30)),
            datum: requestDatum(buyer.address, bottomComp),
        }],
        changeAddress: buyer.address,
    }, buyer, "request", market.address);
    void reqTx;

    const requestU = queryUtxos(market.address).find((u) =>
        u.resolved.value.lovelaces === ADA(30) && assetAmount(u, own.policyHex, rectName(bottomComp)) === 0n)!;
    const deedU = findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(bottomComp))!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)).filter((u) => u !== deedU), ADA(5))!;
    await signSubmitAwait({
        inputs: [
            { utxo: requestU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
            deedU,
            funds,
        ],
        collaterals: [sellerColl],
        outputs: [
            { address: buyer.address, value: withAda(ADA(2), deed(bottomComp, 1n)) },
        ],
        changeAddress: seller.address,
    }, seller, "fill", buyer.address);
    assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(bottomComp)), "buyer received the requested deed");
    console.log("  request filled ✓");
}

// ---------------------------------------------------------------------------
step("8. recover a garbage-datum utxo");
{
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(8))!;
    await signSubmitAwait({
        inputs: [bFunds],
        outputs: [{
            address: market.address,
            value: Value.lovelaces(ADA(5)),
            datum: new DataConstr(7, [new DataI(42)]),
        }],
        changeAddress: buyer.address,
    }, buyer, "send-garbage", market.address);

    const garbageU = queryUtxos(market.address).find((u) => u.resolved.value.lovelaces === ADA(5))!;
    const bFunds2 = pureAdaUtxo(queryUtxos(buyer.address).filter((u) => u.resolved.value.lovelaces !== ADA(10)), ADA(5))!;
    await signSubmitAwait({
        inputs: [
            { utxo: garbageU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRecover() } },
            bFunds2,
        ],
        collaterals: [bColl],
        changeAddress: buyer.address,
    }, buyer, "recover", buyer.address);
    console.log("  garbage utxo swept ✓");
}

// ---------------------------------------------------------------------------
step("9. buyer splits a deed via CARVE (k=1: splitB is splitA only complement)");
const splitA: Rect = { x0: 12, y0: 13, x1: 17, y1: 15 };
const splitB: Rect = { x0: 12, y0: 15, x1: 17, y1: 18 };
{
    const deedU = findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(inner))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(5))!;
    await signSubmitAwait({
        inputs: [deedU, bFunds],
        collaterals: [bColl],
        mints: [{
            value: [deed(inner, -1n), deed(splitA, 1n), deed(splitB, 1n)].reduce((a, b) => Value.add(a, b)),
            script: { ref: refO, redeemer: oMintCarve(inner, splitA) },
        }],
        outputs: [
            { address: buyer.address, value: withAda(ADA(2), deed(splitA, 1n)) },
            { address: buyer.address, value: withAda(ADA(2), deed(splitB, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "split", buyer.address);
    const after = queryUtxos(buyer.address);
    assert(findUtxoWithAsset(after, own.policyHex, rectName(splitA)), "buyer holds piece A");
    assert(findUtxoWithAsset(after, own.policyHex, rectName(splitB)), "buyer holds piece B");
    assert(!findUtxoWithAsset(after, own.policyHex, rectName(inner)), "parent deed burned");
    console.log("  deed split into two pieces ✓");
}

// ---------------------------------------------------------------------------
step("10. buyer MERGES the two pieces back");
{
    const aU = findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(splitA))!;
    const bU = findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(splitB))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(5))!;
    await signSubmitAwait({
        inputs: [aU, bU, bFunds],
        collaterals: [bColl],
        mints: [{
            value: [deed(splitA, -1n), deed(splitB, -1n), deed(inner, 1n)].reduce((a, b) => Value.add(a, b)),
            script: { ref: refO, redeemer: oMintMerge(splitA, splitB) },
        }],
        outputs: [
            { address: buyer.address, value: withAda(ADA(2), deed(inner, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "merge", buyer.address);
    const after = queryUtxos(buyer.address);
    assert(findUtxoWithAsset(after, own.policyHex, rectName(inner)), "union deed minted");
    assert(!findUtxoWithAsset(after, own.policyHex, rectName(splitA)), "piece A burned");
    assert(!findUtxoWithAsset(after, own.policyHex, rectName(splitB)), "piece B burned");
    console.log("  pieces merged back into the original deed ✓");
}

// ---------------------------------------------------------------------------
step("11. buyer posts a request, then CANCELS it");
{
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(8))!;
    await signSubmitAwait({
        inputs: [bFunds],
        outputs: [{
            address: market.address,
            value: Value.lovelaces(ADA(5)),
            datum: requestDatum(buyer.address, topComp),
        }],
        changeAddress: buyer.address,
    }, buyer, "request-2", market.address);

    const requestU = queryUtxos(market.address).find((u) => u.resolved.value.lovelaces === ADA(5))!;
    const bFunds2 = pureAdaUtxo(queryUtxos(buyer.address).filter(notRef(bColl)), ADA(5))!;
    await signSubmitAwait({
        inputs: [
            { utxo: requestU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRequestCancel() } },
            bFunds2,
        ],
        collaterals: [bColl],
        requiredSigners: [buyer.pkh],
        changeAddress: buyer.address,
    }, buyer, "cancel-request", buyer.address);
    assert(!queryUtxos(market.address).some((u) => u.resolved.value.lovelaces === ADA(5)), "request gone");
    console.log("  request posted and canceled, offer refunded ✓");
}

// remaining marketplace utxos: the left + right complement listings
const leftAtMarket = queryUtxos(market.address);
assert(leftAtMarket.length === 2, `2 listings remain (got ${leftAtMarket.length})`);
console.log("\nMARKETPLACE DEVNET E2E — ALL 11 STEPS PASSED ✓ (incl. split, merge, request-cancel)");
