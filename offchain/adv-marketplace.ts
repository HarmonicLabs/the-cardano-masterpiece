// ===========================================================================
//  Marketplace ADVERSARIAL suite #2 — buy / fill / cancel + DOUBLE-SATISFACTION
//  (carve/partialBuy is covered separately in mkt-adversarial.ts).
//
//  Guarantees probed (each malicious tx must be REJECTED at build OR submit;
//  honest happy-paths must succeed on the real devnet node):
//    * buy      — pay the full area, tagged to THIS listing; one order per pay
//    * fill     — deliver the EXACT requested deed to the requester
//    * cancel   — only the seller / requester can reclaim (signature)
//    * NO double-satisfaction: one payment / one delivery cannot close two
//      orders (the `inputs.filter(addr==own).length()==1` guard)
//
//  Run (devnet up):  npx tsx adv-marketplace.ts
// ===========================================================================
import { Address, Credential, StakeCredentials, Value, Hash28, dataToCbor, type Data, type UTxO, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, pureAdaUtxo, txBuilder, submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    stewardshipContract, marketplaceContract, lockContract, lockedDatum,
    freeDatum, listingDatum, requestDatum, lovelacePerPixelDatum,
    oMintInit, oMintFree, oClaim, mBuy, mFill, mListingCancel, mRequestCancel,
    carveComplements, rectName, rectArea, txOutRefData,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();
const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };
const datumHex = (d: Data): string => dataToCbor(d).toString();
const utxoDatumHex = (u: UTxO): string | undefined =>
    u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;

// ---------------------------------------------------------------------------
step("0. wallets + funding");
const seller: Wallet = ensureWallet(`advm-seller-${Date.now()}`);
const buyer: Wallet = ensureWallet(`advm-buyer-${Date.now()}`);
const mallory: Wallet = ensureWallet(`advm-mallory-${Date.now()}`); // an unrelated third party
const fundTx = fundFromGenesis([
    { address: seller.address, lovelace: ADA(10) },
    { address: seller.address, lovelace: ADA(50) },
    { address: seller.address, lovelace: ADA(2000) },
    { address: seller.address, lovelace: ADA(70) },
    { address: buyer.address, lovelace: ADA(10) },
    { address: buyer.address, lovelace: ADA(400) },
    { address: mallory.address, lovelace: ADA(10) },
    { address: mallory.address, lovelace: ADA(100) },
], "fund-advm");
awaitTxAtAddr(mallory.address, fundTx);
const sU = queryUtxos(seller.address);
const sColl = sU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = sU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
const sFunds = sU.find((u) => u.resolved.value.lovelaces === ADA(2000))!;

const own = stewardshipContract(seller.address, genesisU.utxoRef);
const market = marketplaceContract(own.hash.toBuffer());
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceNft = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  seller/buyer/mallory funded; stewardship", own.policyHex, "marketplace", market.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy reference scripts");
const deployFunds = sU.find((u) => u.resolved.value.lovelaces === ADA(70))!;
const lock = lockContract();
const deployHash = await signSubmitAwait({
    inputs: [deployFunds],
    outputs: [
        { address: lock.address, value: Value.lovelaces(ADA(35)), refScript: own.script, datum: lockedDatum() },
        { address: lock.address, value: Value.lovelaces(ADA(25)), refScript: market.script, datum: lockedDatum() },
    ],
    changeAddress: seller.address,
}, seller, "deploy-refs", lock.address.toString());
const atLock = queryUtxos(lock.address);
const refO = atLock.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 0)!;
const refK = atLock.find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 1)!;
const noRefs = (u: { utxoRef: { toString(): string } }): boolean =>
    u.utxoRef.toString() !== refO.utxoRef.toString() && u.utxoRef.toString() !== refK.utxoRef.toString();

// ---------------------------------------------------------------------------
step("1. stewardship init");
{
    const gIdx = sortedRefIndex([genesisU.utxoRef, sFunds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, sFunds],
        collaterals: [sColl],
        mints: [{ value: Value.add(marker(1n), priceNft(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceNft(1n)), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: seller.address,
    }, seller, "stewardship-init", own.address);
}

// ---- helper: seller claims a deed rect from the current free tiling --------
const priceCfg = (): UTxO => findUtxoWithAsset(queryUtxos(own.address), own.policyHex, PRICE_NFT_NAME)!;
async function claim(rect: Rect, freeParent: Rect): Promise<void> {
    const free = queryUtxos(own.address);
    const parentNode = free.find((u) =>
        findUtxoWithAsset([u], own.policyHex, FREE_TOKEN_NAME)
        && utxoDatumHex(u) === datumHex(freeDatum(freeParent)))!;
    const comps = carveComplements(freeParent, rect);
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noRefs).filter(notRef(sColl)), ADA(700))!;
    await signSubmitAwait({
        inputs: [
            { utxo: parentNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(rect) } },
            funds,
        ],
        readonlyRefInputs: [priceCfg()],
        collaterals: [sColl],
        mints: [{ value: Value.add(deed(rect, 1n), marker(BigInt(comps.length - 1))), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: seller.address, value: Value.lovelaces(rectArea(rect) * LOVELACE_PER_PIXEL) },
            { address: seller.address, value: withAda(ADA(2), deed(rect, 1n)) },
        ],
        changeAddress: seller.address,
    }, seller, `claim-${rectName(rect)}`, seller.address);
}

step("2. seller claims 3 deeds (A, B, C) — tiling: A out of canvas, B out of bottom, C out of B-bottom");
const A: Rect = { x0: 10, y0: 10, x1: 20, y1: 20 };
const B: Rect = { x0: 0, y0: 20, x1: 10, y1: 30 };
const C: Rect = { x0: 0, y0: 30, x1: 5, y1: 35 };
// claim A from whole canvas; then B and C from the resulting bottom free node
await claim(A, CANVAS);
const bottomAfterA: Rect = { x0: 0, y0: 20, x1: 1008, y1: 1008 };
await claim(B, bottomAfterA);
const bottomAfterB: Rect = { x0: 0, y0: 30, x1: 1008, y1: 1008 };
await claim(C, bottomAfterB);
console.log("  deeds A,B,C in seller wallet ✓");

const PPP = ADA(1);
// ---- helper: seller lists a held deed at PPP -------------------------------
async function list(rect: Rect): Promise<void> {
    const deedU = findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(rect))!;
    const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noRefs).filter(notRef(sColl)).filter((u) => u !== deedU), ADA(5))!;
    await signSubmitAwait({
        inputs: [deedU, funds],
        outputs: [{ address: market.address, value: withAda(ADA(2), deed(rect, 1n)), datum: listingDatum(seller.address, PPP) }],
        changeAddress: seller.address,
    }, seller, `list-${rectName(rect)}`, market.address);
}

// generic reject harness -----------------------------------------------------
async function expectReject(label: string, mk: () => Promise<ITxBuildArgs>, signer: Wallet): Promise<void> {
    let rejected = false, stage = "build";
    try {
        const tx = await txBuilder().build(await mk());
        tx.signWith(signer.prv);
        stage = "submit";
        submitSignedTx(tx, `adv-${label}`);
    } catch { rejected = true; }
    assert(rejected, `"${label}" MUST be rejected but ACCEPTED (${stage})`);
    console.log(`  rejected at ${stage}: ${label} ✓`);
}
const listingOf = (rect: Rect): UTxO => findUtxoWithAsset(queryUtxos(market.address), own.policyHex, rectName(rect))!;
const buyerFunds = (min: bigint): { coll: UTxO; funds: UTxO } => {
    const bu = queryUtxos(buyer.address);
    const coll = bu.find((u) => u.resolved.value.lovelaces === ADA(10))!;
    return { coll, funds: pureAdaUtxo(bu.filter(notRef(coll)), min)! };
};

// ===========================================================================
step("3. BUY — list A & B; adversarial buys must fail");
await list(A);
await list(B);
{
    // A) DOUBLE-SATISFACTION: spend BOTH listings, pay for ONE
    await expectReject("double-satisfaction buy (2 listings, 1 payment)", async () => {
        const { coll, funds } = buyerFunds(ADA(60));
        const lA = listingOf(A), lB = listingOf(B);
        return {
            inputs: [
                { utxo: lA, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(A) } },
                { utxo: lB, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(B) } },
                funds,
            ],
            collaterals: [coll],
            outputs: [
                { address: seller.address, value: Value.lovelaces(PPP * rectArea(A)), datum: txOutRefData(lA.utxoRef) },
                { address: buyer.address, value: withAda(ADA(2), deed(A, 1n)) },
                { address: buyer.address, value: withAda(ADA(2), deed(B, 1n)) },
            ],
            changeAddress: buyer.address,
        };
    }, buyer);

    // B) underpay the area
    await expectReject("whole-buy underpays the area", async () => {
        const { coll, funds } = buyerFunds(ADA(40));
        const lA = listingOf(A);
        return {
            inputs: [{ utxo: lA, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(A) } }, funds],
            collaterals: [coll],
            outputs: [
                { address: seller.address, value: Value.lovelaces(PPP * rectArea(A) - ADA(1)), datum: txOutRefData(lA.utxoRef) },
                { address: buyer.address, value: withAda(ADA(2), deed(A, 1n)) },
            ],
            changeAddress: buyer.address,
        };
    }, buyer);

    // C) pay correctly but tag to a FOREIGN ref (double-satisfaction primitive)
    await expectReject("whole-buy tags payment to a foreign ref", async () => {
        const { coll, funds } = buyerFunds(ADA(40));
        const lA = listingOf(A);
        return {
            inputs: [{ utxo: lA, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(A) } }, funds],
            collaterals: [coll],
            outputs: [
                { address: seller.address, value: Value.lovelaces(PPP * rectArea(A)), datum: txOutRefData(funds.utxoRef) },
                { address: buyer.address, value: withAda(ADA(2), deed(A, 1n)) },
            ],
            changeAddress: buyer.address,
        };
    }, buyer);

    // HONEST buy of A succeeds
    {
        const { coll, funds } = buyerFunds(ADA(40));
        const lA = listingOf(A);
        await signSubmitAwait({
            inputs: [{ utxo: lA, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mBuy(A) } }, funds],
            collaterals: [coll],
            outputs: [
                { address: seller.address, value: Value.lovelaces(PPP * rectArea(A)), datum: txOutRefData(lA.utxoRef) },
                { address: buyer.address, value: withAda(ADA(2), deed(A, 1n)) },
            ],
            changeAddress: buyer.address,
        }, buyer, "honest-buy-A", buyer.address);
        assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(A)), "buyer holds A");
        console.log("  honest buy of A ✓");
    }
}

// ===========================================================================
step("4. CANCEL — B is still listed; theft attempts must fail");
{
    // Mallory (not the seller) tries to cancel B's listing without the seller's sig
    await expectReject("listing cancel without the seller's signature (deed theft)", async () => {
        const mu = queryUtxos(mallory.address);
        const mColl = mu.find((u) => u.resolved.value.lovelaces === ADA(10))!;
        const mFunds = pureAdaUtxo(mu.filter(notRef(mColl)), ADA(5))!;
        return {
            inputs: [{ utxo: listingOf(B), referenceScript: { refUtxo: refK, datum: "inline", redeemer: mListingCancel() } }, mFunds],
            collaterals: [mColl],
            requiredSigners: [mallory.pkh],           // NOT the seller
            outputs: [{ address: mallory.address, value: withAda(ADA(2), deed(B, 1n)) }],
            changeAddress: mallory.address,
        };
    }, mallory);

    // HONEST cancel by the seller succeeds
    {
        const funds = pureAdaUtxo(queryUtxos(seller.address).filter(noRefs).filter(notRef(sColl)), ADA(5))!;
        await signSubmitAwait({
            inputs: [{ utxo: listingOf(B), referenceScript: { refUtxo: refK, datum: "inline", redeemer: mListingCancel() } }, funds],
            collaterals: [sColl],
            requiredSigners: [seller.pkh],
            changeAddress: seller.address,
        }, seller, "honest-cancel-B", seller.address);
        assert(findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(B)), "seller reclaimed B");
        console.log("  honest cancel of B ✓");
    }
}

// ===========================================================================
step("5. REQUEST / FILL — buyer requests C; deliver-cheats must fail");
{
    // buyer posts TWO identical requests for deed C (offer 30 ada each)
    const post = async (label: string) => {
        const bu = queryUtxos(buyer.address);
        const bColl = bu.find((u) => u.resolved.value.lovelaces === ADA(10))!;
        const bFunds = pureAdaUtxo(bu.filter(notRef(bColl)), ADA(35))!;
        await signSubmitAwait({
            inputs: [bFunds],
            outputs: [{ address: market.address, value: Value.lovelaces(ADA(30)), datum: requestDatum(buyer.address, C) }],
            changeAddress: buyer.address,
        }, buyer, label, market.address);
    };
    await post("request-C-1");
    await post("request-C-2");

    // a THIRD request for C parked at the SAME marketplace payment credential but
    // a DIFFERENT stake credential — the stake-cred double-satisfaction primitive.
    // Before the fix, `fill`'s "exactly one own input" counter compared the FULL
    // address, so this order wouldn't be counted alongside a normal one, letting
    // one deed close two requests. The counter now compares payment creds.
    const marketStakedAddr = Address.testnet(
        Credential.script(new Hash28(market.policyHex)),
        StakeCredentials.keyHash(buyer.pkh),
    );
    {
        const bu = queryUtxos(buyer.address);
        const bColl = bu.find((u) => u.resolved.value.lovelaces === ADA(10))!;
        const bFunds = pureAdaUtxo(bu.filter(notRef(bColl)), ADA(35))!;
        await signSubmitAwait({
            inputs: [bFunds],
            outputs: [{ address: marketStakedAddr, value: Value.lovelaces(ADA(30)), datum: requestDatum(buyer.address, C) }],
            changeAddress: buyer.address,
        }, buyer, "request-C-staked", marketStakedAddr);
    }
    const stakedReqForC = (): UTxO => queryUtxos(marketStakedAddr)
        .find((u) => u.resolved.value.lovelaces === ADA(30))!;
    const requestsForC = (): UTxO[] => queryUtxos(market.address).filter((u) =>
        u.resolved.value.lovelaces === ADA(30) && !findUtxoWithAsset([u], own.policyHex, rectName(C)));
    assert(requestsForC().length === 2, "two open requests for C");
    const deedCU = (): UTxO => findUtxoWithAsset(queryUtxos(seller.address), own.policyHex, rectName(C))!;
    const sfunds = (min: bigint): UTxO => pureAdaUtxo(queryUtxos(seller.address).filter(noRefs).filter(notRef(sColl)).filter((u) => !findUtxoWithAsset([u], own.policyHex, rectName(C))), min)!;

    // A) fill but DELIVER NO DEED to the requester (just take the offer)
    await expectReject("fill takes the offer without delivering the deed", async () => {
        const req = requestsForC()[0];
        return {
            inputs: [{ utxo: req, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } }, sfunds(ADA(5))],
            collaterals: [sColl],
            outputs: [{ address: seller.address, value: Value.lovelaces(ADA(30)) }], // offer to self, no deed to buyer
            changeAddress: seller.address,
        };
    }, seller);

    // B) fill delivering the WRONG deed (A, not C) to the requester
    await expectReject("fill delivers the wrong deed", async () => {
        const req = requestsForC()[0];
        const wrongDeed = findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(A))!; // buyer owns A now
        // seller can't spend buyer's deed; craft as buyer-signed instead
        void wrongDeed;
        const deedC = deedCU();
        return {
            inputs: [
                { utxo: req, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
                deedC, sfunds(ADA(5)),
            ],
            collaterals: [sColl],
            // deliver C to the SELLER (not the requester) — requester gets nothing valid
            outputs: [{ address: seller.address, value: withAda(ADA(2), deed(C, 1n)) }],
            changeAddress: seller.address,
        };
    }, seller);

    // C) DOUBLE-SATISFACTION fill: spend BOTH requests, deliver ONE deed C
    await expectReject("double-satisfaction fill (2 requests, 1 deed)", async () => {
        const [r1, r2] = requestsForC();
        const deedC = deedCU();
        return {
            inputs: [
                { utxo: r1, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
                { utxo: r2, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
                deedC, sfunds(ADA(5)),
            ],
            collaterals: [sColl],
            outputs: [{ address: buyer.address, value: withAda(ADA(2), deed(C, 1n)) }], // only ONE deed for TWO requests
            changeAddress: seller.address,
        };
    }, seller);

    // C') STAKE-CRED DOUBLE-SATISFACTION: one request at market.address + one at
    // the same payment cred with a DIFFERENT stake cred, closed by ONE deed. The
    // pre-fix full-address counter would have let this through; the payment-cred
    // counter counts both requests as ours and rejects.
    await expectReject("double-satisfaction fill across mismatched stake creds (2 requests, 1 deed)", async () => {
        const rNorm = requestsForC()[0];
        const rStaked = stakedReqForC();
        const deedC = deedCU();
        return {
            inputs: [
                { utxo: rNorm, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
                { utxo: rStaked, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
                deedC, sfunds(ADA(5)),
            ],
            collaterals: [sColl],
            outputs: [{ address: buyer.address, value: withAda(ADA(2), deed(C, 1n)) }], // ONE deed for TWO requests
            changeAddress: seller.address,
        };
    }, seller);

    // requester tries to cancel — but requester is buyer; Mallory can't cancel it
    await expectReject("request cancel without the requester's signature", async () => {
        const req = requestsForC()[0];
        const mu = queryUtxos(mallory.address);
        const mColl = mu.find((u) => u.resolved.value.lovelaces === ADA(10))!;
        const mFunds = pureAdaUtxo(mu.filter(notRef(mColl)), ADA(5))!;
        return {
            inputs: [{ utxo: req, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mRequestCancel() } }, mFunds],
            collaterals: [mColl],
            requiredSigners: [mallory.pkh],
            changeAddress: mallory.address,
        };
    }, mallory);

    // HONEST fill: seller delivers C to the requester (buyer), takes one offer
    {
        const req = requestsForC()[0];
        const deedC = deedCU();
        await signSubmitAwait({
            inputs: [
                { utxo: req, referenceScript: { refUtxo: refK, datum: "inline", redeemer: mFill() } },
                deedC, sfunds(ADA(5)),
            ],
            collaterals: [sColl],
            outputs: [{ address: buyer.address, value: withAda(ADA(2), deed(C, 1n)) }],
            changeAddress: seller.address,
        }, seller, "honest-fill-C", buyer.address);
        assert(findUtxoWithAsset(queryUtxos(buyer.address), own.policyHex, rectName(C)), "requester received C");
        console.log("  honest fill of C ✓");
    }
}

console.log("\nMARKETPLACE BUY/FILL/CANCEL ADVERSARIAL SUITE — ALL CHECKS PASSED ✓");
