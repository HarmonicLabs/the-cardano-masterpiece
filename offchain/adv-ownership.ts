// ===========================================================================
//  Ownership (land-registry) ADVERSARIAL suite.
//
//  Guarantees probed (each malicious tx REJECTED at build OR submit; honest
//  happy-paths must succeed on the real devnet node):
//    claim      — pay area×price to the owner, price read from the GENUINE
//                 price-NFT ref node; re-tile the spent free rect into its
//                 EXACT guillotine complements; one free node spent per tx
//    change     — only the owner (signature) may retune; >= floor; the price
//                 NFT stays on the config node
//    ownerClaim — only the protocol owner may take a free deed
//    carve      — target must be ⊆ parent
//    merge      — the two deeds must be edge-adjacent (union is a rectangle)
//
//  Deeds are kept TINY (4x4 px) — at 5 ADA/px even a 10-px strip would cost
//  hundreds of ADA — and the tiling is tracked by hand.
//
//  Run (devnet up):  npx tsx adv-ownership.ts
// ===========================================================================
import { Value, Hash28, dataToCbor, type Data, type UTxO, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, pureAdaUtxo, txBuilder, submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    ownershipContract, lockContract, lockedDatum, freeDatum, lovelacePerPixelDatum,
    oMintInit, oMintFree, oMintCarve, oMintMerge, oClaim, oOwnerClaim, oPriceChange,
    carveComplements, rectName, rectArea,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, MIN_LOVELACE_PER_PIXEL, type Rect,
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
const owner: Wallet = ensureWallet(`advo-owner-${Date.now()}`);   // protocolOwner
const user: Wallet = ensureWallet(`advo-user-${Date.now()}`);
const mallory: Wallet = ensureWallet(`advo-mallory-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: owner.address, lovelace: ADA(10) },
    { address: owner.address, lovelace: ADA(50) },
    { address: owner.address, lovelace: ADA(200) },
    { address: owner.address, lovelace: ADA(70) },
    { address: user.address, lovelace: ADA(10) },
    { address: user.address, lovelace: ADA(1500) },
    { address: mallory.address, lovelace: ADA(10) },
    { address: mallory.address, lovelace: ADA(100) },
], "fund-advo");
awaitTxAtAddr(mallory.address, fundTx);
const oU = queryUtxos(owner.address);
const oColl = oU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = oU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
const oInit = oU.find((u) => u.resolved.value.lovelaces === ADA(200))!;
const userColl = queryUtxos(user.address).find((u) => u.resolved.value.lovelaces === ADA(10))!;

const own = ownershipContract(owner.address, genesisU.utxoRef);
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceNft = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  protocol owner:", owner.address.toString());
console.log("  ownership     :", own.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy ownership reference script");
const lock = lockContract();
const deployHash = await signSubmitAwait({
    inputs: [oU.find((u) => u.resolved.value.lovelaces === ADA(70))!],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(40)), refScript: own.script, datum: lockedDatum() }],
    changeAddress: owner.address,
}, owner, "deploy-ref", lock.address.toString());
const refO = queryUtxos(lock.address).find((u) => u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 0)!;
const noRef = notRef(refO);

// ---------------------------------------------------------------------------
step("1. ownership init");
{
    const gIdx = sortedRefIndex([genesisU.utxoRef, oInit.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, oInit],
        collaterals: [oColl],
        mints: [{ value: Value.add(marker(1n), priceNft(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceNft(1n)), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: owner.address,
    }, owner, "ownership-init", own.address);
}

const priceCfg = (): UTxO => findUtxoWithAsset(queryUtxos(own.address), own.policyHex, PRICE_NFT_NAME)!;
const freeNodes = (): UTxO[] => queryUtxos(own.address).filter((u) => findUtxoWithAsset([u], own.policyHex, FREE_TOKEN_NAME));
const freeNodeOf = (r: Rect): UTxO => freeNodes().find((u) => utxoDatumHex(u) === datumHex(freeDatum(r)))!;
const userFunds = (min: bigint): UTxO => pureAdaUtxo(queryUtxos(user.address).filter(noRef).filter(notRef(userColl)), min)!;
const heldDeed = (w: Wallet, r: Rect): UTxO => findUtxoWithAsset(queryUtxos(w.address), own.policyHex, rectName(r))!;

// honest claim of `rect` out of the free node covering `parent` (claimant = user)
async function claim(rect: Rect, parent: Rect): Promise<void> {
    const comps = carveComplements(parent, rect);
    await signSubmitAwait({
        inputs: [
            { utxo: freeNodeOf(parent), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(rect) } },
            userFunds(ADA(200)),
        ],
        readonlyRefInputs: [priceCfg()],
        collaterals: [userColl],
        mints: [{ value: Value.add(deed(rect, 1n), marker(BigInt(comps.length - 1))), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: owner.address, value: Value.lovelaces(rectArea(rect) * LOVELACE_PER_PIXEL) },
            { address: user.address, value: withAda(ADA(2), deed(rect, 1n)) },
        ],
        changeAddress: user.address,
    }, user, `claim-${new TextDecoder().decode(rectName(rect))}`, user.address);
}

// generic reject harness
async function expectReject(label: string, mk: () => Promise<ITxBuildArgs> | ITxBuildArgs, signer: Wallet): Promise<void> {
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

// ---------------------------------------------------------------------------
// Tiling built by hand (all deeds 4x4 = 16 px = 80 ADA at 5 ADA/px):
//   claim D1 {0,0,4,4}   from canvas   -> free FB {0,4,1008,1008}, FR {4,0,1008,4}
//   claim D2 {4,0,8,4}   from FR        -> free FR2 {8,0,1008,4}
//   claim D3 {0,4,4,8}   from FB        -> free FB2 {0,8,1008,1008}, FR3 {4,4,1008,8}
// adjacency: D1|D2 side-by-side, D1/D3 stacked, D2 & D3 only corner-touch.
// ---------------------------------------------------------------------------
step("2. setup tiling — claim tiny deeds D1, D2, D3");
const D1: Rect = { x0: 0, y0: 0, x1: 4, y1: 4 };
const D2: Rect = { x0: 4, y0: 0, x1: 8, y1: 4 };
const D3: Rect = { x0: 0, y0: 4, x1: 4, y1: 8 };
const FB: Rect = { x0: 0, y0: 4, x1: 1008, y1: 1008 };
const FR: Rect = { x0: 4, y0: 0, x1: 1008, y1: 4 };
const FR2: Rect = { x0: 8, y0: 0, x1: 1008, y1: 4 };
const FB2: Rect = { x0: 0, y0: 8, x1: 1008, y1: 1008 };
const FR3: Rect = { x0: 4, y0: 4, x1: 1008, y1: 8 };
await claim(D1, CANVAS);
await claim(D2, FR);
await claim(D3, FB);
console.log("  user holds D1,D2,D3; free nodes FR2, FB2, FR3 ✓");

// build a claim of `rect` from the free node covering `parent`; overrides let
// each attack corrupt exactly one thing
type ClaimOpts = { comps?: Rect[]; payLovelace?: bigint; payTo?: Wallet; refPrice?: UTxO[] };
function claimArgs(rect: Rect, parent: Rect, o: ClaimOpts = {}): ITxBuildArgs {
    const comps = o.comps ?? carveComplements(parent, rect);
    return {
        inputs: [
            { utxo: freeNodeOf(parent), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(rect) } },
            userFunds(ADA(200)),
        ],
        readonlyRefInputs: o.refPrice ?? [priceCfg()],
        collaterals: [userColl],
        mints: [{ value: Value.add(deed(rect, 1n), marker(BigInt(comps.length - 1))), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: (o.payTo ?? owner).address, value: Value.lovelaces(o.payLovelace ?? rectArea(rect) * LOVELACE_PER_PIXEL) },
            { address: user.address, value: withAda(ADA(2), deed(rect, 1n)) },
        ],
        changeAddress: user.address,
    };
}

// ---------------------------------------------------------------------------
step("3. CLAIM adversarial attempts");
const c1: Rect = { x0: 0, y0: 8, x1: 4, y1: 12 };   // ⊆ FB2 {0,8,1008,1008}
{
    // A) double-satisfaction: spend TWO free nodes, one payment
    await expectReject("double-satisfaction claim (2 free nodes, 1 payment)", () => {
        const r1: Rect = { x0: 0, y0: 8, x1: 4, y1: 12 };   // ⊆ FB2
        const r2: Rect = { x0: 8, y0: 0, x1: 12, y1: 4 };   // ⊆ FR2
        const comps1 = carveComplements(FB2, r1), comps2 = carveComplements(FR2, r2);
        return {
            inputs: [
                { utxo: freeNodeOf(FB2), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(r1) } },
                { utxo: freeNodeOf(FR2), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(r2) } },
                userFunds(ADA(200)),
            ],
            readonlyRefInputs: [priceCfg()],
            collaterals: [userColl],
            mints: [{ value: [deed(r1, 1n), deed(r2, 1n), marker(BigInt(comps1.length + comps2.length - 2))].reduce((a, b) => Value.add(a, b)), script: { ref: refO, redeemer: oMintFree() } }],
            outputs: [
                ...comps1.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
                ...comps2.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
                { address: owner.address, value: Value.lovelaces(rectArea(r1) * LOVELACE_PER_PIXEL) }, // pays for r1 only
                { address: user.address, value: withAda(ADA(2), deed(r1, 1n)) },
                { address: user.address, value: withAda(ADA(2), deed(r2, 1n)) },
            ],
            changeAddress: user.address,
        };
    }, user);

    // B) underpay the owner
    await expectReject("claim underpays the owner", () =>
        claimArgs(c1, FB2, { payLovelace: rectArea(c1) * LOVELACE_PER_PIXEL - ADA(1) }), user);

    // C) pay someone other than the protocol owner
    await expectReject("claim pays a non-owner instead of the protocol owner", () =>
        claimArgs(c1, FB2, { payTo: user }), user);

    // D) do not reference the genuine price NFT (reference a free node instead)
    await expectReject("claim without referencing the genuine price-NFT node", () =>
        claimArgs(c1, FB2, { refPrice: [freeNodeOf(FR2)] }), user);

    // E) omit one guillotine complement (drop a free output + its marker)
    await expectReject("claim omits a free complement", () => {
        const comps = carveComplements(FB2, c1);
        return claimArgs(c1, FB2, { comps: comps.slice(0, comps.length - 1) });
    }, user);

    // F) emit a wrong-rect complement (shrink the first by 1 px)
    await expectReject("claim emits a wrong-rect complement", () => {
        const comps = carveComplements(FB2, c1).map((r, i) => i === 0 ? { ...r, x1: r.x1 - 1 } : r);
        return claimArgs(c1, FB2, { comps });
    }, user);

    // G) claim a rect NOT contained in the spent free node (built inline so
    //    buildooor builds it and the contract's rectContains is what rejects)
    await expectReject("claim a rect outside the spent free node", () => {
        const outside: Rect = { x0: 0, y0: 200, x1: 4, y1: 204 }; // valid rect, ⊄ FB2? (FB2 covers it) -> use FR2
        // FR2 = {8,0,1008,4}; a rect at y=200 is NOT contained there
        return {
            inputs: [
                { utxo: freeNodeOf(FR2), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(outside) } },
                userFunds(ADA(200)),
            ],
            readonlyRefInputs: [priceCfg()],
            collaterals: [userColl],
            mints: [{ value: deed(outside, 1n), script: { ref: refO, redeemer: oMintFree() } }],
            outputs: [
                { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(FR2) }, // preserve the marker
                { address: owner.address, value: Value.lovelaces(rectArea(outside) * LOVELACE_PER_PIXEL) },
                { address: user.address, value: withAda(ADA(2), deed(outside, 1n)) },
            ],
            changeAddress: user.address,
        };
    }, user);

    // HONEST claim from FB2 succeeds
    await claim(c1, FB2);
    assert(heldDeed(user, c1), "user holds the honestly-claimed deed");
    console.log("  honest claim ✓");
}

// ---------------------------------------------------------------------------
step("4. CHANGE (price) adversarial attempts");
{
    const newPrice = ADA(9);
    const changeArgs = (o: { sign?: Wallet; value?: bigint; keepNft?: boolean; nftTo?: Wallet } = {}): ITxBuildArgs => {
        const cfg = priceCfg();
        return {
            inputs: [
                { utxo: cfg, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oPriceChange() } },
                pureAdaUtxo(queryUtxos(owner.address).filter(noRef).filter(notRef(oColl)), ADA(5))!,
            ],
            collaterals: [oColl],
            requiredSigners: o.sign ? [o.sign.pkh] : [],
            outputs: [
                (o.keepNft === false)
                    ? { address: (o.nftTo ?? owner).address, value: withAda(ADA(3), priceNft(1n)) } // NFT leaves the config node
                    : { address: own.address, value: withAda(ADA(3), priceNft(1n)), datum: lovelacePerPixelDatum(o.value ?? newPrice) },
            ],
            changeAddress: owner.address,
        };
    };

    await expectReject("price change without the owner's signature", () => changeArgs({ sign: undefined }), mallory);
    await expectReject("price change below the 1-ADA floor", () => changeArgs({ sign: owner, value: MIN_LOVELACE_PER_PIXEL - 1n }), owner);
    await expectReject("price change that removes the price NFT from the config node", () => changeArgs({ sign: owner, keepNft: false, nftTo: owner }), owner);

    await signSubmitAwait(changeArgs({ sign: owner, value: newPrice }), owner, "honest-change", own.address);
    console.log("  honest price change ✓ (now", Number(newPrice) / 1e6, "ADA/px)");
}

// ---------------------------------------------------------------------------
step("5. OWNERCLAIM — only the protocol owner may take a free deed");
{
    const ocR: Rect = { x0: 4, y0: 4, x1: 8, y1: 8 };  // ⊆ FR3 {4,4,1008,8}
    const ownerClaimArgs = (signer: Wallet, payFrom: Wallet): ITxBuildArgs => {
        const comps = carveComplements(FR3, ocR);
        const pu = queryUtxos(payFrom.address);
        const pColl = pu.find((u) => u.resolved.value.lovelaces === ADA(10))!;
        return {
            inputs: [
                { utxo: freeNodeOf(FR3), referenceScript: { refUtxo: refO, datum: "inline", redeemer: oOwnerClaim(ocR) } },
                pureAdaUtxo(pu.filter(notRef(pColl)).filter(noRef), ADA(10))!,
            ],
            collaterals: [pColl],
            requiredSigners: [signer.pkh],
            mints: [{ value: Value.add(deed(ocR, 1n), marker(BigInt(comps.length - 1))), script: { ref: refO, redeemer: oMintFree() } }],
            outputs: [
                ...comps.map((x) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(x) })),
                { address: owner.address, value: withAda(ADA(2), deed(ocR, 1n)) }, // deed must go to the owner
            ],
            changeAddress: payFrom.address,
        };
    };

    // Mallory tries the free owner-claim (signs as herself, not the owner)
    await expectReject("ownerClaim by a non-owner", () => ownerClaimArgs(mallory, mallory), mallory);

    // HONEST ownerClaim by the owner
    await signSubmitAwait(ownerClaimArgs(owner, owner), owner, "honest-ownerclaim", owner.address);
    assert(heldDeed(owner, ocR), "owner got the free deed");
    console.log("  honest ownerClaim ✓");
}

// ---------------------------------------------------------------------------
step("6. CARVE / MERGE geometry attempts");
{
    // carve: target must be ⊆ parent. D3 = {0,4,4,8}; target sticks out past y=8.
    await expectReject("carve a target not contained in the parent", () => {
        const parent = D3, bad: Rect = { x0: 0, y0: 4, x1: 4, y1: 40 }; // y1=40 > parent.y1=8
        return {
            inputs: [heldDeed(user, parent), userFunds(ADA(5))],
            collaterals: [userColl],
            mints: [{ value: Value.add(deed(parent, -1n), deed(bad, 1n)), script: { ref: refO, redeemer: oMintCarve(parent, bad) } }],
            outputs: [{ address: user.address, value: withAda(ADA(2), deed(bad, 1n)) }],
            changeAddress: user.address,
        };
    }, user);

    // merge: the two deeds must be edge-adjacent. D2 & D3 only touch at a corner.
    await expectReject("merge two non-adjacent (corner-touching) deeds", () => {
        const a = D2, b = D3, union: Rect = { x0: 0, y0: 0, x1: 8, y1: 8 }; // pretend union
        return {
            inputs: [heldDeed(user, a), heldDeed(user, b), userFunds(ADA(5))],
            collaterals: [userColl],
            mints: [{ value: [deed(a, -1n), deed(b, -1n), deed(union, 1n)].reduce((x, y) => Value.add(x, y)), script: { ref: refO, redeemer: oMintMerge(a, b) } }],
            outputs: [{ address: user.address, value: withAda(ADA(2), deed(union, 1n)) }],
            changeAddress: user.address,
        };
    }, user);

    // HONEST carve of D3 into two side-by-side halves
    {
        const parent = D3, left: Rect = { x0: 0, y0: 4, x1: 2, y1: 8 };
        const comps = carveComplements(parent, left); // right {2,4,4,8}
        await signSubmitAwait({
            inputs: [heldDeed(user, parent), userFunds(ADA(5))],
            collaterals: [userColl],
            mints: [{ value: [deed(parent, -1n), deed(left, 1n), ...comps.map((c) => deed(c, 1n))].reduce((x, y) => Value.add(x, y)), script: { ref: refO, redeemer: oMintCarve(parent, left) } }],
            outputs: [
                { address: user.address, value: withAda(ADA(2), deed(left, 1n)) },
                ...comps.map((c) => ({ address: user.address, value: withAda(ADA(2), deed(c, 1n)) })),
            ],
            changeAddress: user.address,
        }, user, "honest-carve", user.address);
        console.log("  honest carve ✓");
    }

    // HONEST merge of D1 + D2 (side by side) into their union
    {
        const a = D1, b = D2, union: Rect = { x0: 0, y0: 0, x1: 8, y1: 4 };
        await signSubmitAwait({
            inputs: [heldDeed(user, a), heldDeed(user, b), userFunds(ADA(5))],
            collaterals: [userColl],
            mints: [{ value: [deed(a, -1n), deed(b, -1n), deed(union, 1n)].reduce((x, y) => Value.add(x, y)), script: { ref: refO, redeemer: oMintMerge(a, b) } }],
            outputs: [{ address: user.address, value: withAda(ADA(2), deed(union, 1n)) }],
            changeAddress: user.address,
        }, user, "honest-merge", user.address);
        assert(heldDeed(user, union), "merged union deed held");
        console.log("  honest merge ✓");
    }
}

console.log("\nOWNERSHIP ADVERSARIAL SUITE — ALL CHECKS PASSED ✓");
