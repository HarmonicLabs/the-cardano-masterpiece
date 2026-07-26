// ===========================================================================
//  DEVNET scenario: mint 3 ownership NFTs at 3 DIFFERENT prices per pixel.
//
//    npx tsx mint3-prices.ts
//
//  The protocol owner sets the price on the NFT-validated LovelacePerPixel
//  config node; each claim REFERENCES it and must pay area x price. Between
//  claims the owner retunes the price UP (3 -> 5 -> 8 ADA/px), and we prove:
//    * each claim at the CURRENT price succeeds and mints its deed;
//    * a claim paying the PREVIOUS (now-too-low) price is REJECTED;
//    * the config datum reflects each change, NFT preserved.
// ===========================================================================
import { Value, Hash28, DataConstr, DataI } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, pureAdaUtxo, assetAmount, type Wallet,
} from "./lib.ts";
import {
    ownershipContract, lockContract, lockedDatum,
    freeDatum, lovelacePerPixelDatum, oMintInit, oMintFree, oClaim, oPriceChange,
    carveComplements, rectName, rectArea,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, type Rect,
} from "./contracts.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();

// three disjoint 2x2 plots along the top row, claimed left-to-right so each
// carves cleanly out of the previous claim's right-hand complement
const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };
const plotA: Rect = { x0: 0, y0: 0, x1: 2, y1: 2 };
const plotB: Rect = { x0: 2, y0: 0, x1: 4, y1: 2 };
const plotC: Rect = { x0: 4, y0: 0, x1: 6, y1: 2 };
// three distinct, INCREASING prices (so paying the previous one under-pays)
const P1 = ADA(3), P2 = ADA(5), P3 = ADA(8);

// ---------------------------------------------------------------------------
step("0. wallets + funding");
const owner: Wallet = ensureWallet(`p3-owner-${Date.now()}`);   // protocol owner
const claimer: Wallet = ensureWallet(`p3-claim-${Date.now()}`); // pays to claim
const fundTx = fundFromGenesis([
    { address: owner.address, lovelace: ADA(10) },     // collateral
    { address: owner.address, lovelace: ADA(50) },     // ownership genesis utxo
    { address: owner.address, lovelace: ADA(70) },     // ref deploy
    { address: owner.address, lovelace: ADA(60) },     // price-change funds
    { address: claimer.address, lovelace: ADA(10) },   // collateral
    { address: claimer.address, lovelace: ADA(200) },  // claim payments (<= 8*4 each)
], "fund-p3");
awaitTxAtAddr(claimer.address, fundTx);
const ownerU = queryUtxos(owner.address);
const ownerColl = ownerU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const genesisU = ownerU.find((u) => u.resolved.value.lovelaces === ADA(50))!;
const claimerColl = queryUtxos(claimer.address).find((u) => u.resolved.value.lovelaces === ADA(10))!;
console.log("  owner  :", owner.address.toString());
console.log("  claimer:", claimer.address.toString());

const own = ownershipContract(owner.address, genesisU.utxoRef);
const deed = (r: Rect, n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), rectName(r), n);
const marker = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), FREE_TOKEN_NAME, n);
const priceTok = (n: bigint): Value => Value.singleAsset(new Hash28(own.policyHex), PRICE_NFT_NAME, n);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);
console.log("  ownership:", own.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy ownership ref (Lock-parked)");
const lock = lockContract();
const deployHash = await signSubmitAwait({
    inputs: [ownerU.find((u) => u.resolved.value.lovelaces === ADA(70))!],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(35)), refScript: own.script, datum: lockedDatum() }],
    changeAddress: owner.address,
}, owner, "deploy-ref", lock.address.toString());
const refO = queryUtxos(lock.address).find((u) =>
    u.utxoRef.id.toString() === deployHash && Number(u.utxoRef.index) === 0)!;
const notDeploy = notRef(refO);

// ---------------------------------------------------------------------------
step(`1. ownership init (price = ${P1 / ADA(1)} ADA/px)`);
{
    const funds = pureAdaUtxo(queryUtxos(owner.address).filter(notDeploy).filter(notRef(ownerColl)), ADA(20))!;
    const gIdx = sortedRefIndex([genesisU.utxoRef, funds.utxoRef], genesisU.utxoRef);
    await signSubmitAwait({
        inputs: [genesisU, funds],
        collaterals: [ownerColl],
        mints: [{ value: Value.add(marker(1n), priceTok(1n)), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), priceTok(1n)), datum: lovelacePerPixelDatum(P1) },
        ],
        changeAddress: owner.address,
    }, owner, "ownership-init", own.address);
}

// ---- helpers ---------------------------------------------------------------
const rectOf = (d: unknown): Rect => {
    const c = (d as DataConstr).fields[0] as DataConstr;
    return {
        x0: Number((c.fields[0] as DataI).int), y0: Number((c.fields[1] as DataI).int),
        x1: Number((c.fields[2] as DataI).int), y1: Number((c.fields[3] as DataI).int),
    };
};
const contains = (o: Rect, i: Rect): boolean => o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;
/** the free node whose rect contains `r` */
function freeNodeFor(r: Rect): { rect: Rect; utxo: ReturnType<typeof queryUtxos>[number] } {
    for (const u of queryUtxos(own.address)) {
        if (assetAmount(u, own.policyHex, FREE_TOKEN_NAME) !== 1n) continue;
        const d = u.resolved.datum;
        if (!(d instanceof DataConstr) || Number(d.constr) !== 0) continue;
        const rect = rectOf(d);
        if (contains(rect, r)) return { rect, utxo: u };
    }
    throw new Error(`no free node contains ${JSON.stringify(r)}`);
}
const priceCfg = () => findUtxoWithAsset(queryUtxos(own.address), own.policyHex, PRICE_NFT_NAME)!;

/** build a claim tx paying `payPerPixel` to the owner; returns the ITxBuildArgs */
function claimArgs(claimed: Rect, payPerPixel: bigint) {
    const node = freeNodeFor(claimed);
    const comps = carveComplements(node.rect, claimed);
    const funds = pureAdaUtxo(
        queryUtxos(claimer.address).filter(notRef(claimerColl)), rectArea(claimed) * payPerPixel + ADA(5))!;
    const mintVal = comps.length - 1 === 0
        ? deed(claimed, 1n)
        : Value.add(deed(claimed, 1n), marker(BigInt(comps.length - 1)));
    return {
        inputs: [
            { utxo: node.utxo, referenceScript: { refUtxo: refO, datum: "inline" as const, redeemer: oClaim(claimed) } },
            funds,
        ],
        readonlyRefInputs: [priceCfg()],
        collaterals: [claimerColl],
        mints: [{ value: mintVal, script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), marker(1n)), datum: freeDatum(r) })),
            { address: owner.address, value: Value.lovelaces(rectArea(claimed) * payPerPixel) },
            { address: claimer.address, value: withAda(ADA(2), deed(claimed, 1n)) },
        ],
        changeAddress: claimer.address,
    };
}

async function changePriceTo(newPrice: bigint): Promise<void> {
    const cfg = priceCfg();
    const funds = pureAdaUtxo(queryUtxos(owner.address).filter(notDeploy).filter(notRef(ownerColl)), ADA(10))!;
    await signSubmitAwait({
        inputs: [
            { utxo: cfg, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oPriceChange() } },
            funds,
        ],
        collaterals: [ownerColl],
        requiredSigners: [owner.pkh],
        outputs: [{ address: own.address, value: withAda(ADA(3), priceTok(1n)), datum: lovelacePerPixelDatum(newPrice) }],
        changeAddress: owner.address,
    }, owner, "price-change", own.address);
    const after = priceCfg();
    const pv = ((after.resolved.datum as DataConstr).fields[0] as DataI).int;
    assert.equal(pv, newPrice, "config price updated");
    console.log(`  price -> ${newPrice / ADA(1)} ADA/px, NFT preserved ✓`);
}

// ---------------------------------------------------------------------------
step(`2. claim A ${rectName(plotA) && "(2x2)"} at ${P1 / ADA(1)} ADA/px`);
await signSubmitAwait(claimArgs(plotA, P1), claimer, "claim-A", own.address);
assert(findUtxoWithAsset(queryUtxos(claimer.address), own.policyHex, rectName(plotA)), "claimer holds deed A");
console.log(`  deed A minted, paid ${rectArea(plotA) * P1 / ADA(1)} ADA (${rectArea(plotA)} px x ${P1 / ADA(1)}) ✓`);

// ---------------------------------------------------------------------------
step(`3. owner raises price ${P1 / ADA(1)} -> ${P2 / ADA(1)} ADA/px`);
await changePriceTo(P2);

step("3b. ADVERSARIAL: claim B at the OLD price must FAIL");
{
    let rejected = false;
    try { await signSubmitAwait(claimArgs(plotB, P1), claimer, "claim-B-underpay", own.address); }
    catch { rejected = true; }
    assert(rejected, "under-paying the new price must be rejected");
    console.log(`  paying ${P1 / ADA(1)} ADA/px after the raise was rejected ✓`);
}

step(`3c. claim B at the NEW price ${P2 / ADA(1)} ADA/px`);
await signSubmitAwait(claimArgs(plotB, P2), claimer, "claim-B", own.address);
assert(findUtxoWithAsset(queryUtxos(claimer.address), own.policyHex, rectName(plotB)), "claimer holds deed B");
console.log(`  deed B minted, paid ${rectArea(plotB) * P2 / ADA(1)} ADA ✓`);

// ---------------------------------------------------------------------------
step(`4. owner raises price ${P2 / ADA(1)} -> ${P3 / ADA(1)} ADA/px`);
await changePriceTo(P3);

step("4b. ADVERSARIAL: claim C at the OLD price must FAIL");
{
    let rejected = false;
    try { await signSubmitAwait(claimArgs(plotC, P2), claimer, "claim-C-underpay", own.address); }
    catch { rejected = true; }
    assert(rejected, "under-paying the new price must be rejected");
    console.log(`  paying ${P2 / ADA(1)} ADA/px after the raise was rejected ✓`);
}

step(`4c. claim C at the NEW price ${P3 / ADA(1)} ADA/px`);
await signSubmitAwait(claimArgs(plotC, P3), claimer, "claim-C", own.address);
assert(findUtxoWithAsset(queryUtxos(claimer.address), own.policyHex, rectName(plotC)), "claimer holds deed C");
console.log(`  deed C minted, paid ${rectArea(plotC) * P3 / ADA(1)} ADA ✓`);

// ---------------------------------------------------------------------------
step("5. verify final state");
{
    const held = queryUtxos(claimer.address);
    for (const [name, r] of [["A", plotA], ["B", plotB], ["C", plotC]] as const)
        assert(findUtxoWithAsset(held, own.policyHex, rectName(r)), `deed ${name} held`);
    const pv = ((priceCfg().resolved.datum as DataConstr).fields[0] as DataI).int;
    assert.equal(pv, P3, "final config price is P3");
    console.log(`  3 deeds held by claimer; config price = ${P3 / ADA(1)} ADA/px ✓`);
    console.log(`\n  paid: A=${rectArea(plotA) * P1 / ADA(1)}  B=${rectArea(plotB) * P2 / ADA(1)}  C=${rectArea(plotC) * P3 / ADA(1)} ADA (3 different prices)`);
}

console.log("\nALL STEPS PASSED ✓");
