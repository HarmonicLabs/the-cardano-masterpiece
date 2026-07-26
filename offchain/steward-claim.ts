// ===========================================================================
//  DEVNET test: Free.stewardClaim — the protocol steward claims free space for
//  FREE (no 5 ADA/px payment), gated by the steward's signature and requiring
//  the deed to land with the steward. Includes an adversarial check that a
//  NON-steward cannot use it, and that omitting the steward signature fails.
// ===========================================================================
import { Value, Hash28 } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, txBuilder, submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    stewardshipContract, lockContract, lockedDatum, freeDatum,
    oMintInit, oMintFree, oClaim, oStewardClaim, carveComplements, lovelacePerPixelDatum,
    rectName, rectArea, FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();

const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };
const stewardRect: Rect = { x0: 400, y0: 400, x1: 600, y1: 600 };  // 200x200 center-ish, steward-claimed free
const stewardCost = rectArea(stewardRect) * LOVELACE_PER_PIXEL;      // what it WOULD cost via `claim`

step("0. wallets + funding");
const steward: Wallet = ensureWallet(`oc-steward-${Date.now()}`);
const stranger: Wallet = ensureWallet(`oc-stranger-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: steward.address, lovelace: ADA(10) },       // collateral
    { address: steward.address, lovelace: ADA(50) },       // stewardship genesis utxo
    { address: steward.address, lovelace: ADA(70) },       // ref deploys
    { address: steward.address, lovelace: ADA(30) },       // funds (NO big payment needed!)
    { address: stranger.address, lovelace: ADA(10) },    // collateral
    { address: stranger.address, lovelace: ADA(30) },    // funds
], "fund-oc");
awaitTxAtAddr(stranger.address, fundTx);
const stewardU = queryUtxos(steward.address);
const stewardColl = stewardU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = stewardU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
console.log("  protocol steward:", steward.address.toString());
console.log("  stranger      :", stranger.address.toString());
console.log("  200x200 steward-claim would cost via `claim`:", stewardCost / 1_000_000n, "ada — steward pays 0");

// protocol steward IS the stewardship param
const own = stewardshipContract(steward.address, genesisU.utxoRef);
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceTok = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  stewardship:", own.policyHex);

step("0b. deploy stewardship ref (Lock-parked)");
const lock = lockContract();
const deployFunds = stewardU.find((u) => u.resolved.value.lovelaces === ADA(70))!;
const deployHash = await signSubmitAwait({
    inputs: [deployFunds],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(40)), refScript: own.script, datum: lockedDatum() }],
    changeAddress: steward.address,
}, steward, "deploy-ref", lock.address.toString());
const refO = queryUtxos(lock.address).find((u) => u.utxoRef.id.toString() === deployHash)!;
const noRef = notRef(refO);

step("1. stewardship init");
{
    const funds = pureAdaUtxo(queryUtxos(steward.address).filter(noRef).filter(notRef(stewardColl)), ADA(20))!;
    const gIdx = sortedRefIndex([genesisU.utxoRef, funds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, funds],
        collaterals: [stewardColl],
        mints: [{ value: Value.add(marker(1n), priceTok(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceTok(1n)), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: steward.address,
    }, steward, "stewardship-init", own.address);
}

const comps = carveComplements(CANVAS, stewardRect);

// build the stewardClaim tx args for a given claimant wallet + redeemer
function stewardClaimArgs(fundsFor: Wallet, signAs: Wallet, redeemer: import("@harmoniclabs/buildooor").DataConstr, coll: import("@harmoniclabs/buildooor").UTxO) {
    const freeNode = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, FREE_TOKEN_NAME)!;
    const funds = pureAdaUtxo(queryUtxos(fundsFor.address).filter(noRef).filter(notRef(coll)), ADA(20))!;
    return {
        inputs: [
            { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline" as const, redeemer } },
            funds,
        ],
        collaterals: [coll],
        requiredSigners: [signAs.pkh],
        mints: [{
            value: Value.add(deed(stewardRect, 1n), marker(BigInt(comps.length - 1))),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            // deed to the protocol STEWARD (no protocol payment output at all)
            { address: steward.address, value: withAda(ADA(2), deed(stewardRect, 1n)) },
        ],
        changeAddress: steward.address,
    };
}

step("2. ADVERSARIAL: stranger tries stewardClaim (must fail — not the steward's signature)");
{
    // stranger builds it, deed still addressed to steward, but only STRANGER signs
    const freeNode = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, FREE_TOKEN_NAME)!;
    const funds = pureAdaUtxo(queryUtxos(stranger.address).filter(notRef(queryUtxos(stranger.address).find((u) => u.resolved.value.lovelaces === ADA(10))!)), ADA(20))!;
    const sColl = queryUtxos(stranger.address).find((u) => u.resolved.value.lovelaces === ADA(10))!;
    let rejected = false;
    try {
        const tx = await txBuilder().build({
            inputs: [
                { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oStewardClaim(stewardRect) } },
                funds,
            ],
            collaterals: [sColl],
            requiredSigners: [stranger.pkh],
            mints: [{
                value: Value.add(deed(stewardRect, 1n), marker(BigInt(comps.length - 1))),
                script: { ref: refO, redeemer: oMintFree() },
            }],
            outputs: [
                ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
                { address: steward.address, value: withAda(ADA(2), deed(stewardRect, 1n)) },
            ],
            changeAddress: stranger.address,
        });
        tx.signWith(stranger.prv);
        submitSignedTx(tx, "stranger-stewardclaim");
    } catch {
        rejected = true;
    }
    assert(rejected, "stranger's stewardClaim was accepted — SECURITY FAILURE");
    console.log("  stranger rejected (steward signature required) ✓");
}

step("3. protocol steward stewardClaims 200x200 for FREE");
{
    await signSubmitAwait(
        stewardClaimArgs(steward, steward, oStewardClaim(stewardRect), stewardColl),
        steward, "steward-claim", steward.address,
    );
    // security property: the minted deed reached the protocol STEWARD (this is
    // what the validator's deed-reaches-steward check enforces)
    assert(findUtxoWithAsset(queryUtxos(steward.address), own.policyHex, rectName(stewardRect)), "steward holds the free-claimed deed");
    // the remainder re-tiled as free-node complements: each is a marker-bearing
    // utxo at the contract carrying the complement's coords in its datum (NOT a
    // named deed)
    const freeNodes = queryUtxos(own.address).filter((u) => assetAmount(u, own.policyHex, FREE_TOKEN_NAME) === 1n);
    assert(freeNodes.length === comps.length, `expected ${comps.length} free-node complements, got ${freeNodes.length}`);
    console.log(`  steward claimed ${new TextDecoder().decode(rectName(stewardRect))} (${rectArea(stewardRect)} px) for 0 ada; ${comps.length} complements re-tiled ✓`);
}

console.log("\nSTEWARD-CLAIM DEVNET TEST — ALL STEPS PASSED ✓");
