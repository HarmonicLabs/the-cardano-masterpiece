// ===========================================================================
//  DEVNET scenario: claim a 256x256 square at the canvas center, list it,
//  then partial-buy the centered 128x128 square out of it (on-chain carve).
//
//  Canvas 1008x1008, center (504, 504).
//    256-square: (376,376)-(632,632)  area 65536 px -> claim = 327,680 ADA
//    128-square: (440,440)-(568,568)  area 16384 px -> buy   =  16,384 ADA @ 1/px
//  The 128 sits strictly inside the 256, so the carve mints 4 complements,
//  each relisted on the same terms.
// ===========================================================================
import { Value, Hash28 } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, pureAdaUtxo, type Wallet,
} from "./lib.ts";
import {
    ownershipContract, marketplaceContract, lockContract, lockedDatum,
    freeDatum, lovelacePerPixelDatum, listingDatum, oMintInit, oMintFree, oMintCarve, oClaim,
    mPartialBuy, carveComplements, rectName, rectArea, txOutRefData,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();

const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };
const square256: Rect = { x0: 376, y0: 376, x1: 632, y1: 632 };
const square128: Rect = { x0: 440, y0: 440, x1: 568, y1: 568 };
const PPP = ADA(1); // 1 ada per pixel listing price

const claimCost = rectArea(square256) * LOVELACE_PER_PIXEL; // 327,680 ADA
const buyCost = rectArea(square128) * PPP;                  //  16,384 ADA
console.log("256-square:", rectName(square256).length, "→ claim", claimCost / 1_000_000n, "ada");
console.log("128-square: buy", buyCost / 1_000_000n, "ada @ 1/px");

// ---------------------------------------------------------------------------
step("0. wallets + funding");
const seller: Wallet = ensureWallet(`ctr-seller-${Date.now()}`);
const buyer: Wallet = ensureWallet(`ctr-buyer-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: seller.address, lovelace: ADA(10) },        // collateral
    { address: seller.address, lovelace: ADA(50) },        // ownership genesis utxo
    { address: seller.address, lovelace: ADA(340_000) },   // claim funds (327,680 returns to self)
    { address: seller.address, lovelace: ADA(70) },        // ref-script deploys
    { address: seller.address, lovelace: ADA(20) },        // list funds
    { address: buyer.address, lovelace: ADA(10) },         // collateral
    { address: buyer.address, lovelace: ADA(20_000) },     // partial-buy funds
], "fund-ctr");
awaitTxAtAddr(buyer.address, fundTx);
const sellerU = queryUtxos(seller.address);
const sellerColl = sellerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = sellerU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
console.log("  seller:", seller.address.toString());
console.log("  buyer :", buyer.address.toString());

const own = ownershipContract(seller.address, genesisU.utxoRef);
const market = marketplaceContract(own.hash.toBuffer());
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceTok = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  ownership  :", own.policyHex);
console.log("  marketplace:", market.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy reference scripts (Lock-parked)");
const deployFunds = sellerU.find((u) => u.resolved.value.lovelaces === ADA(70))!;
const lock = lockContract();
const deployHash = await signSubmitAwait({
    inputs: [deployFunds],
    outputs: [
        { address: lock.address, value: Value.lovelaces(ADA(35)), refScript: own.script, datum: lockedDatum() },
        { address: lock.address, value: Value.lovelaces(ADA(25)), refScript: market.script, datum: lockedDatum() },
    ],
    changeAddress: seller.address,
}, seller, "deploy-refs", lock.address.toString());
const afterDeploy = queryUtxos(lock.address);
const refO = afterDeploy.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 0)!;
const refK = afterDeploy.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 1)!;
const noDeployRefs = (u: { utxoRef: { toString(): string } }): boolean =>
    u.utxoRef.toString() !== refO.utxoRef.toString() && u.utxoRef.toString() !== refK.utxoRef.toString();

// ---------------------------------------------------------------------------
step("1. ownership init");
{
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)), ADA(20))!;
    const gIdx = sortedRefIndex([genesisU.utxoRef, funds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, funds],
        collaterals: [sellerColl],
        mints: [{ value: Value.add(marker(1n), priceTok(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceTok(1n)), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: seller.address,
    }, seller, "ownership-init", own.address);
}

// ---------------------------------------------------------------------------
step("2. seller claims the 256x256 center square");
const claimComps = carveComplements(CANVAS, square256); // top, bottom, left, right
{
    const freeNode = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, FREE_TOKEN_NAME)!;
    const priceCfg = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, PRICE_NFT_NAME)!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)), ADA(340_000))!;
    await signSubmitAwait({
        inputs: [
            { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(square256) } },
            funds,
        ],
        readonlyRefInputs: [priceCfg],
        collaterals: [sellerColl],
        mints: [{
            value: Value.add(deed(square256, 1n), marker(BigInt(claimComps.length - 1))),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            ...claimComps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: seller.address, value: Value.lovelaces(claimCost) }, // 5 ada/px to protocolOwner (= seller)
            { address: seller.address, value: withAda(ADA(2), deed(square256, 1n)) },
        ],
        changeAddress: seller.address,
    }, seller, "claim-256", seller.address);
    assert(findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(square256)), "seller holds the 256 deed");
    console.log(`  claimed ${new TextDecoder().decode(rectName(square256))} (${rectArea(square256)} px, ${claimComps.length} complements) ✓`);
}

// ---------------------------------------------------------------------------
step("3. seller lists the 256 square at 1 ada/px");
{
    const deedU = findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(square256))!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)).filter((u) => u !== deedU), ADA(10))!;
    await signSubmitAwait({
        inputs: [deedU, funds],
        outputs: [{
            address: market.address,
            value: withAda(ADA(2), deed(square256, 1n)),
            datum: listingDatum(seller.address, PPP),
        }],
        changeAddress: seller.address,
    }, seller, "list-256", market.address);
    assert(findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(square256)), "256 deed listed");
    console.log("  listed ✓");
}

// ---------------------------------------------------------------------------
step("4. buyer partial-buys the 128x128 center square (on-chain carve)");
const buyComps = carveComplements(square256, square128); // top, bottom, left, right
{
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(square256))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(20_000))!;
    const carveValue = [deed(square256, -1n), deed(square128, 1n), ...buyComps.map((c) => deed(c, 1n))]
        .reduce((a, b) => Value.add(a, b));
    await signSubmitAwait({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(square256, square128) } },
            bFunds,
        ],
        collaterals: [bColl],
        mints: [{ value: carveValue, script: { ref: refO, redeemer: oMintCarve(square256, square128) } }],
        outputs: [
            ...buyComps.map((c) => ({ address: market.address, value: withAda(ADA(2), deed(c, 1n)), datum: listingDatum(seller.address, PPP) })),
            { address: seller.address, value: Value.lovelaces(buyCost), datum: txOutRefData(listingU.utxoRef) },
            { address: buyer.address, value: withAda(ADA(2), deed(square128, 1n)) },
        ],
        changeAddress: buyer.address,
    }, buyer, "partial-buy-128", buyer.address);
    assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(square128)), "buyer holds the 128 deed");
    const relisted = queryUtxos(market.address);
    for (const c of buyComps)
        assert(findUtxoWithAsset(relisted, own.policyHex, rectName(c)), `complement ${JSON.stringify(c)} relisted`);
    assert(!findUtxoWithAsset(relisted, own.policyHex, rectName(square256)), "parent listing consumed");
    console.log(`  bought ${new TextDecoder().decode(rectName(square128))} for ${buyCost / 1_000_000n} ada; ${buyComps.length} complements relisted ✓`);
}

// ---------------------------------------------------------------------------
step("summary");
console.log("  buyer  holds:", new TextDecoder().decode(rectName(square128)));
console.log("  market holds:", buyComps.map((c) => new TextDecoder().decode(rectName(c))).join(", "));
console.log("\nCENTER CLAIM + PARTIAL BUY — ALL STEPS PASSED ✓");
