// ===========================================================================
//  Marketplace ADVERSARIAL tests on the LOCAL DEVNET — real node phase-2.
//
//  Focus: the `partialBuy` (carve) path. A buyer carves a sub-rect out of a
//  listed deed. The contract must guarantee, in ONE tx:
//    (i)  the buyer receives ONLY the carved `bought` sub-rect — never a
//         complement;
//    (ii) EVERY guillotine complement goes back into the marketplace as a
//         fresh Listing under the SAME seller and the SAME price.
//
//  We keep one pristine listing and fire a battery of malicious partialBuy
//  txs at it — each MUST be rejected (at build OR submit; either counts). The
//  listing is untouched by a rejected tx, so all attacks reuse it. Finally a
//  HONEST partialBuy must succeed, and we assert (i) + (ii) on-chain.
//
//  Run: (devnet already up)  npx tsx mkt-adversarial.ts
// ===========================================================================
import { Value, Hash28, dataToCbor, type Data, type UTxO } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, txBuilder,
    submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    stewardshipContract, marketplaceContract, lockContract, lockedDatum,
    freeDatum, listingDatum, lovelacePerPixelDatum,
    oMintInit, oMintFree, oMintCarve, oClaim, mPartialBuy,
    carveComplements, rectName, rectArea, txOutRefData,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();
const datumHex = (d: Data): string => dataToCbor(d).toString();
const utxoDatumHex = (u: UTxO): string | undefined =>
    u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;

const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };

// ---------------------------------------------------------------------------
step("0. wallets + funding");
const seller: Wallet = ensureWallet(`adv-seller-${Date.now()}`);
const buyer: Wallet = ensureWallet(`adv-buyer-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: seller.address, lovelace: ADA(10) },   // collateral
    { address: seller.address, lovelace: ADA(50) },   // stewardship genesis utxo
    { address: seller.address, lovelace: ADA(700) },  // funds (claim pays 500 to self)
    { address: seller.address, lovelace: ADA(70) },   // ref-script deploys
    { address: buyer.address, lovelace: ADA(10) },    // collateral
    { address: buyer.address, lovelace: ADA(300) },   // funds
], "fund-adv");
awaitTxAtAddr(buyer.address, fundTx);
const sellerU = queryUtxos(seller.address);
const sellerColl = sellerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = sellerU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
const sellerFunds = sellerU.find((u) => u.resolved.value.lovelaces === ADA(700))!;
console.log("  seller:", seller.address.toString());
console.log("  buyer :", buyer.address.toString());

// contracts: fresh stewardship instance (protocolSteward = seller) + its marketplace
const own = stewardshipContract(seller.address, genesisU.utxoRef);
const market = marketplaceContract(own.hash.toBuffer());
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceNft = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  stewardship  :", own.policyHex);
console.log("  marketplace:", market.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy reference scripts (ALWAYS use refs, incl. tests)");
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
step("1. stewardship init (FREE marker + PRICE NFT + price config node)");
{
    const gIdx = sortedRefIndex([genesisU.utxoRef, sellerFunds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, sellerFunds],
        collaterals: [sellerColl],
        mints: [{
            value: Value.add(marker(1n), priceNft(1n)),
            script: { ref: refO, redeemer: oMintInit(gIdx) },
        }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceNft(1n)), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: seller.address,
    }, seller, "stewardship-init", own.address);
    console.log("  free node + price config live ✓");
}

// ---------------------------------------------------------------------------
step("2. seller claims (10,10)-(20,20), pays 5 ada/px to protocol steward (self)");
const deedRect: Rect = { x0: 10, y0: 10, x1: 20, y1: 20 }; // 100 px
const claimComps = carveComplements(CANVAS, deedRect);      // 4 free-node complements
{
    const free = queryUtxos(own.address);
    const freeNode = findUtxoWithAsset(free, own.policyHex, FREE_TOKEN_NAME)!;
    const priceCfg = findUtxoWithAsset(free, own.policyHex, PRICE_NFT_NAME)!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noDeployRefs).filter(notRef(sellerColl)), ADA(650))!;
    await signSubmitAwait({
        inputs: [
            { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(deedRect) } },
            funds,
        ],
        readonlyRefInputs: [priceCfg], // price is referenced (NFT-validated), not spent
        collaterals: [sellerColl],
        mints: [{
            value: Value.add(deed(deedRect, 1n), marker(BigInt(claimComps.length - 1))),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            ...claimComps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: seller.address, value: Value.lovelaces(rectArea(deedRect) * LOVELACE_PER_PIXEL) },
            { address: seller.address, value: withAda(ADA(2), deed(deedRect, 1n)) },
        ],
        changeAddress: seller.address,
    }, seller, "claim", seller.address);
    assert(findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(deedRect)), "seller holds deed");
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
// The carve we (honestly or maliciously) attempt: buy the inner rect.
// Complements come back in carve order: top, bottom, left, right.
// ---------------------------------------------------------------------------
const inner: Rect = { x0: 12, y0: 13, x1: 17, y1: 18 };  // 25 px -> 25 ada
const comps = carveComplements(deedRect, inner);         // [top, bottom, left, right]
assert.equal(comps.length, 4, "inner carve yields 4 complements");
const payAmt = PPP * rectArea(inner);                    // 25 ada
const carveMint = [deed(deedRect, -1n), deed(inner, 1n), ...comps.map((c) => deed(c, 1n))]
    .reduce((a, b) => Value.add(a, b));

// An honest set of outputs; each attack is this with ONE thing corrupted.
type Out = { address: any; value: Value; datum?: Data };
const honestRelists = (): Out[] =>
    comps.map((c) => ({ address: market.address, value: withAda(ADA(2), deed(c, 1n)), datum: listingDatum(seller.address, PPP) }));
const honestPay = (tagRef: UTxO): Out =>
    ({ address: seller.address, value: Value.lovelaces(payAmt), datum: txOutRefData(tagRef.utxoRef) });
const honestBuyerOut = (): Out =>
    ({ address: buyer.address, value: withAda(ADA(2), deed(inner, 1n)) });

// build+sign+submit a partialBuy with the given outputs; expect REJECTION
const attempt = async (label: string, mkOutputs: (listingU: UTxO) => Out[]): Promise<void> => {
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(deedRect))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(60))!;
    let rejected = false, stage = "build";
    try {
        const tx = await txBuilder().build({
            inputs: [
                { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, inner) } },
                bFunds,
            ],
            collaterals: [bColl],
            mints: [{ value: carveMint, script: { ref: refO, redeemer: oMintCarve(deedRect, inner) } }],
            outputs: mkOutputs(listingU),
            changeAddress: buyer.address,
        });
        tx.signWith(buyer.prv);
        stage = "submit";
        submitSignedTx(tx, `adv-${label}`);
    } catch { rejected = true; }
    assert(rejected, `"${label}" MUST be rejected but the ledger ACCEPTED it (${stage})`);
    console.log(`  rejected at ${stage}: ${label} ✓`);
};

// ---------------------------------------------------------------------------
step("4. ADVERSARIAL partialBuy attempts (must ALL fail; listing stays pristine)");
{
    // A — buyer DIVERTS the top complement to their own wallet: buyer would
    //     walk away with more than the carved `inner`. The top complement is
    //     then missing from the marketplace outputs.
    await attempt("divert a complement to the buyer (buyer gets more than carved)", (listingU) => {
        const relists = honestRelists();
        const [top, ...rest] = relists;
        return [
            { address: buyer.address, value: top.value },  // top -> buyer, no listing datum
            ...rest,
            honestPay(listingU),
            honestBuyerOut(),
        ];
    });

    // B — relist a complement back to the market but under the BUYER as seller:
    //     stewardship of the remaining pieces would silently change hands.
    await attempt("relist a complement under the buyer as seller (steward changed)", (listingU) => {
        const relists = honestRelists();
        relists[0] = { ...relists[0], datum: listingDatum(buyer.address, PPP) };
        return [...relists, honestPay(listingU), honestBuyerOut()];
    });

    // C — relist a complement at a CHEAPER price than the original terms.
    await attempt("relist a complement at a lower price (terms changed)", (listingU) => {
        const relists = honestRelists();
        relists[0] = { ...relists[0], datum: listingDatum(seller.address, PPP / 2n) };
        return [...relists, honestPay(listingU), honestBuyerOut()];
    });

    // D — underpay the seller for the carved area.
    await attempt("underpay the seller for the bought area", (listingU) => [
        ...honestRelists(),
        { address: seller.address, value: Value.lovelaces(payAmt - ADA(1)), datum: txOutRefData(listingU.utxoRef) },
        honestBuyerOut(),
    ]);

    // E — pay the right amount but tag it to the WRONG utxo ref (double-satisfaction).
    await attempt("pay the seller but tag the payment to a foreign ref", (listingU) => {
        const buyerU = queryUtxos(buyer.address);
        const foreign = buyerU.find((u) => u.utxoRef.toString() !== listingU.utxoRef.toString())!;
        return [
            ...honestRelists(),
            { address: seller.address, value: Value.lovelaces(payAmt), datum: txOutRefData(foreign.utxoRef) },
            honestBuyerOut(),
        ];
    });

    // F — sneak an EXTRA output to the marketplace (breaks the exact-relist count).
    await attempt("add an extra unexpected output to the marketplace", (listingU) => [
        ...honestRelists(),
        { address: market.address, value: Value.lovelaces(ADA(2)), datum: listingDatum(seller.address, PPP) },
        honestPay(listingU),
        honestBuyerOut(),
    ]);

    console.log("  all adversarial partialBuy attempts rejected ✓");
}

// ---------------------------------------------------------------------------
step("5. HONEST partialBuy succeeds — verify buyer got ONLY the carved part");
{
    const listingU = findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(deedRect))!;
    const buyerU = queryUtxos(buyer.address);
    const bColl = buyerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    const bFunds = pureAdaUtxo(buyerU.filter(notRef(bColl)), ADA(60))!;
    await signSubmitAwait({
        inputs: [
            { utxo: listingU, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mPartialBuy(deedRect, inner) } },
            bFunds,
        ],
        collaterals: [bColl],
        mints: [{ value: carveMint, script: { ref: refO, redeemer: oMintCarve(deedRect, inner) } }],
        outputs: [...honestRelists(), honestPay(listingU), honestBuyerOut()],
        changeAddress: buyer.address,
    }, buyer, "partial-buy", buyer.address);

    // (i) buyer holds the carved inner deed and NONE of the complements
    const afterBuyer = queryUtxos(buyer.address);
    assert(findUtxoWithAsset(afterBuyer, own.policyHex, rectName(inner)), "buyer holds the carved inner deed");
    for (const c of comps)
        assert(!findUtxoWithAsset(afterBuyer, own.policyHex, rectName(c)),
            `buyer must NOT hold complement ${rectName(c)} — got more than carved`);
    console.log("  buyer received ONLY the carved inner rect ✓");

    // (ii) every complement is back in the marketplace under the SAME steward + price
    const atMarket = queryUtxos(market.address);
    const wantDatum = datumHex(listingDatum(seller.address, PPP));
    for (const c of comps) {
        const relisted = findUtxoWithAsset(atMarket, own.policyHex, rectName(c));
        assert(relisted, `complement ${rectName(c)} is relisted at the marketplace`);
        assert.equal(assetAmount(relisted!, own.policyHex, rectName(c)), 1n, "exactly one deed on the listing");
        assert.equal(utxoDatumHex(relisted!), wantDatum,
            `complement ${rectName(c)} relisted under the SAME seller + price`);
    }
    // the parent deed is gone from the market (carved/burned)
    assert(!findUtxoWithAsset(atMarket, own.policyHex, rectName(deedRect)), "parent listing consumed");
    console.log("  all 4 complements stayed in the marketplace under the same steward & price ✓");
}

console.log("\nMARKETPLACE CARVE ADVERSARIAL SUITE — ALL CHECKS PASSED ✓");
