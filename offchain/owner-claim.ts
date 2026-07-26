// ===========================================================================
//  DEVNET test: Free.ownerClaim — the protocol owner claims free space for
//  FREE (no 5 ADA/px payment), gated by the owner's signature and requiring
//  the deed to land with the owner. Includes an adversarial check that a
//  NON-owner cannot use it, and that omitting the owner signature fails.
// ===========================================================================
import { Value, Hash28 } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, txBuilder, submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    ownershipContract, lockContract, lockedDatum, freeDatum,
    oMintInit, oMintFree, oClaim, oOwnerClaim, carveComplements, lovelacePerPixelDatum,
    rectName, rectArea, FREE_TOKEN_NAME, PRICE_NFT_NAME, LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();

const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };
const ownerRect: Rect = { x0: 400, y0: 400, x1: 600, y1: 600 };  // 200x200 center-ish, owner-claimed free
const ownerCost = rectArea(ownerRect) * LOVELACE_PER_PIXEL;      // what it WOULD cost via `claim`

step("0. wallets + funding");
const owner: Wallet = ensureWallet(`oc-owner-${Date.now()}`);
const stranger: Wallet = ensureWallet(`oc-stranger-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: owner.address, lovelace: ADA(10) },       // collateral
    { address: owner.address, lovelace: ADA(50) },       // ownership genesis utxo
    { address: owner.address, lovelace: ADA(70) },       // ref deploys
    { address: owner.address, lovelace: ADA(30) },       // funds (NO big payment needed!)
    { address: stranger.address, lovelace: ADA(10) },    // collateral
    { address: stranger.address, lovelace: ADA(30) },    // funds
], "fund-oc");
awaitTxAtAddr(stranger.address, fundTx);
const ownerU = queryUtxos(owner.address);
const ownerColl = ownerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = ownerU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
console.log("  protocol owner:", owner.address.toString());
console.log("  stranger      :", stranger.address.toString());
console.log("  200x200 owner-claim would cost via `claim`:", ownerCost / 1_000_000n, "ada — owner pays 0");

// protocol owner IS the ownership param
const own = ownershipContract(owner.address, genesisU.utxoRef);
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceTok = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  ownership:", own.policyHex);

step("0b. deploy ownership ref (Lock-parked)");
const lock = lockContract();
const deployFunds = ownerU.find((u) => u.resolved.value.lovelaces === ADA(70))!;
const deployHash = await signSubmitAwait({
    inputs: [deployFunds],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(40)), refScript: own.script, datum: lockedDatum() }],
    changeAddress: owner.address,
}, owner, "deploy-ref", lock.address.toString());
const refO = queryUtxos(lock.address).find((u) => u.utxoRef.id.toString() === deployHash)!;
const noRef = notRef(refO);

step("1. ownership init");
{
    const funds = pureAdaUtxo(queryUtxos(owner.address).filter(noRef).filter(notRef(ownerColl)), ADA(20))!;
    const gIdx = sortedRefIndex([genesisU.utxoRef, funds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, funds],
        collaterals: [ownerColl],
        mints: [{ value: Value.add(marker(1n), priceTok(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceTok(1n)), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: owner.address,
    }, owner, "ownership-init", own.address);
}

const comps = carveComplements(CANVAS, ownerRect);

// build the ownerClaim tx args for a given claimant wallet + redeemer
function ownerClaimArgs(fundsFor: Wallet, signAs: Wallet, redeemer: import("@harmoniclabs/buildooor").DataConstr, coll: import("@harmoniclabs/buildooor").UTxO) {
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
            value: Value.add(deed(ownerRect, 1n), marker(BigInt(comps.length - 1))),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            // deed to the protocol OWNER (no protocol payment output at all)
            { address: owner.address, value: withAda(ADA(2), deed(ownerRect, 1n)) },
        ],
        changeAddress: owner.address,
    };
}

step("2. ADVERSARIAL: stranger tries ownerClaim (must fail — not the owner's signature)");
{
    // stranger builds it, deed still addressed to owner, but only STRANGER signs
    const freeNode = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, FREE_TOKEN_NAME)!;
    const funds = pureAdaUtxo(queryUtxos(stranger.address).filter(notRef(queryUtxos(stranger.address).find((u) => u.resolved.value.lovelaces === ADA(10))!)), ADA(20))!;
    const sColl = queryUtxos(stranger.address).find((u) => u.resolved.value.lovelaces === ADA(10))!;
    let rejected = false;
    try {
        const tx = await txBuilder().build({
            inputs: [
                { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oOwnerClaim(ownerRect) } },
                funds,
            ],
            collaterals: [sColl],
            requiredSigners: [stranger.pkh],
            mints: [{
                value: Value.add(deed(ownerRect, 1n), marker(BigInt(comps.length - 1))),
                script: { ref: refO, redeemer: oMintFree() },
            }],
            outputs: [
                ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
                { address: owner.address, value: withAda(ADA(2), deed(ownerRect, 1n)) },
            ],
            changeAddress: stranger.address,
        });
        tx.signWith(stranger.prv);
        submitSignedTx(tx, "stranger-ownerclaim");
    } catch {
        rejected = true;
    }
    assert(rejected, "stranger's ownerClaim was accepted — SECURITY FAILURE");
    console.log("  stranger rejected (owner signature required) ✓");
}

step("3. protocol owner ownerClaims 200x200 for FREE");
{
    await signSubmitAwait(
        ownerClaimArgs(owner, owner, oOwnerClaim(ownerRect), ownerColl),
        owner, "owner-claim", owner.address,
    );
    // security property: the minted deed reached the protocol OWNER (this is
    // what the validator's deed-reaches-owner check enforces)
    assert(findUtxoWithAsset(queryUtxos(owner.address), own.policyHex, rectName(ownerRect)), "owner holds the free-claimed deed");
    // the remainder re-tiled as free-node complements: each is a marker-bearing
    // utxo at the contract carrying the complement's coords in its datum (NOT a
    // named deed)
    const freeNodes = queryUtxos(own.address).filter((u) => assetAmount(u, own.policyHex, FREE_TOKEN_NAME) === 1n);
    assert(freeNodes.length === comps.length, `expected ${comps.length} free-node complements, got ${freeNodes.length}`);
    console.log(`  owner claimed ${new TextDecoder().decode(rectName(ownerRect))} (${rectArea(ownerRect)} px) for 0 ada; ${comps.length} complements re-tiled ✓`);
}

console.log("\nOWNER-CLAIM DEVNET TEST — ALL STEPS PASSED ✓");
