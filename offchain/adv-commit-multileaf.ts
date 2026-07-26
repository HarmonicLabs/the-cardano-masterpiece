// ===========================================================================
//  MULTI-LEAF commit ADVERSARIAL suite — the new attack surface of the
//  list-form `RootNft.commit` (sync many leaves in one tx).
//
//  Guarantees probed (each malicious tx REJECTED at build OR submit; the honest
//  multi-leaf commit must succeed on the real devnet node):
//    * every committed position's new CID = the ACTUAL referenced leaf's CID
//    * positions NOT referenced stay byte-identical
//    * the reference list is strictly ASCENDING by leaf index (no dup/reorder)
//    * only genuine leaves (marker token) may be referenced
//
//  Setup: deploy, hatch leaves 0 & 1, own a 1-px column covering both, edit a
//  pixel in each, then attack the commit that syncs both.
//
//  Run (devnet up):  npx tsx adv-commit-multileaf.ts
// ===========================================================================
import { Value, Hash28, UTxO, dataToCbor, type Data, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, txBuilder, submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    stewardshipContract, masterpieceContract, lockContract, lockedDatum, buildBmpHeader,
    rootDatum, leafDatum, nurseryDatum, initialChunk, freeDatum, lovelacePerPixelDatum,
    mpMintInit, mpHatch, mpEdit, mpCommit, oMintInit, oMintFree, oStewardClaim,
    carveComplements, rectName,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME,
    N_LEAFS, LINE_LENGTH, MIN_LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const LEAF_ADA = ADA(60);
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();
const utxoDatumHex = (u: UTxO): string | undefined =>
    u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;
const datumHex = (d: Data): string => dataToCbor(d).toString();
type TokenEntry = [Uint8Array, bigint];
const tokens = (p: string, es: TokenEntry[]): Value => es.reduce((v, [n, a]) => Value.add(v, Value.singleAsset(new Hash28(p), n, a)), Value.zero);
const withAda = (l: bigint, p: string, es: TokenEntry[]): Value => Value.add(Value.lovelaces(l), tokens(p, es));
const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };

// ---------------------------------------------------------------------------
step("0. wallet + funding");
const dep: Wallet = ensureWallet(`advc-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: dep.address, lovelace: ADA(10) },
    { address: dep.address, lovelace: ADA(5) },
    { address: dep.address, lovelace: ADA(5) },
    { address: dep.address, lovelace: ADA(110) },
    { address: dep.address, lovelace: ADA(400) },
], "fund-advc");
awaitTxAtAddr(dep.address, fundTx);
const dU = queryUtxos(dep.address);
const coll = dU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const fivers = dU.filter((u) => u.resolved.value.lovelaces === ADA(5));
const genesisO = fivers[0]!, genesisM = fivers[1]!;
const fundRef = dU.find((u) => u.resolved.value.lovelaces === ADA(110))!;
assert(coll && genesisO && genesisM && genesisO.utxoRef.toString() !== genesisM.utxoRef.toString() && fundRef, "funding");

const bmp = buildBmpHeader();
const own = stewardshipContract(dep.address, genesisO.utxoRef);
const mp = masterpieceContract(own.hash.toBuffer(), genesisM.utxoRef, bmp);
const lock = lockContract();
const work = (min: bigint): UTxO => pureAdaUtxo(queryUtxos(dep.address).filter(notRef(coll)).filter(notRef(fundRef)), min)!;
console.log("  masterpiece:", mp.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy reference scripts");
const dO = await signSubmitAwait({
    inputs: [fundRef],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(35)), refScript: own.script, datum: lockedDatum() }],
    changeAddress: dep.address,
}, dep, "deploy-ref-own", dep.address);
const dM = await signSubmitAwait({
    inputs: [queryUtxos(dep.address).find((u) => u.utxoRef.id.toString() === dO && Number(u.utxoRef.index) === 1)!],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(60)), refScript: mp.script, datum: lockedDatum() }],
    changeAddress: dep.address,
}, dep, "deploy-ref-mp", dep.address);
const atLock = queryUtxos(lock.address);
const refO = atLock.find((u) => u.utxoRef.id.toString() === dO && Number(u.utxoRef.index) === 0)!;
const refM = atLock.find((u) => u.utxoRef.id.toString() === dM && Number(u.utxoRef.index) === 0)!;

// ---------------------------------------------------------------------------
step("1. stewardship init + 2. masterpiece init");
{
    const w = work(ADA(200));
    await signSubmitAwait({
        inputs: [genesisO, w],
        collaterals: [coll],
        mints: [{ value: tokens(own.policyHex, [[FREE_TOKEN_NAME, 1n], [PRICE_NFT_NAME, 1n]]), script: { ref: refO, redeemer: oMintInit(sortedRefIndex([genesisO.utxoRef, w.utxoRef], genesisO.utxoRef)) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), own.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), own.policyHex, [[PRICE_NFT_NAME, 1n]]), datum: lovelacePerPixelDatum(MIN_LOVELACE_PER_PIXEL) },
        ],
        changeAddress: dep.address,
    }, dep, "stewardship-init", own.address);
}
const initCid = cidV1Raw(initialChunk());
const initialLeafCids = Array.from({ length: N_LEAFS }, () => initCid);
const rootD0 = rootDatum(initialLeafCids, bmp);
{
    const w = work(ADA(100));
    const ins = [genesisM, w];
    await signSubmitAwait({
        inputs: ins,
        collaterals: [coll],
        mints: [{ value: tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)], [ROOT_REF_NFT_NAME, 1n], [ROOT_USER_NFT_NAME, 1n]]), script: { ref: refM, redeemer: mpMintInit(sortedRefIndex(ins.map((u) => u.utxoRef), genesisM.utxoRef)) } }],
        outputs: [
            { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]]), datum: nurseryDatum(0) },
            { address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootD0.data },
            { address: dep.address, value: withAda(ADA(2), mp.policyHex, [[ROOT_USER_NFT_NAME, 1n]]) },
        ],
        changeAddress: dep.address,
    }, dep, "masterpiece-init", mp.address);
}

// ---------------------------------------------------------------------------
step("3. stewardClaim a column covering leaves 0 & 1 (rows 0..23, col 0)");
const COL: Rect = { x0: 0, y0: 0, x1: 1, y1: 24 };
const colName = rectName(COL);
{
    const freeNode = findUtxoWithAsset(queryUtxos(own.address), own.policyHex, FREE_TOKEN_NAME)!;
    const comps = carveComplements(CANVAS, COL);
    await signSubmitAwait({
        inputs: [{ utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oStewardClaim(COL) } }, work(ADA(50))],
        collaterals: [coll],
        requiredSigners: [dep.pkh],
        mints: [{ value: Value.add(Value.singleAsset(new Hash28(own.policyHex), colName, 1n), tokens(own.policyHex, [[FREE_TOKEN_NAME, BigInt(comps.length - 1)]])), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), own.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum(r) })),
            { address: dep.address, value: withAda(ADA(2), own.policyHex, [[colName, 1n]]) },
        ],
        changeAddress: dep.address,
    }, dep, "stewardclaim-col", dep.address);
}

// ---------------------------------------------------------------------------
step("4. hatch leaves 0 & 1");
async function hatch(idx: number): Promise<void> {
    const rem = N_LEAFS - idx;
    const nursery = queryUtxos(mp.address).find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === BigInt(rem) && utxoDatumHex(u) === datumHex(nurseryDatum(idx)))!;
    await signSubmitAwait({
        inputs: [{ utxo: nursery, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } }, work(ADA(100))],
        collaterals: [coll],
        outputs: [
            { address: mp.address, value: withAda(LEAF_ADA, mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(idx, initialChunk()) },
            { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(rem - 1)]]), datum: nurseryDatum(idx + 1) },
        ],
        changeAddress: dep.address,
    }, dep, `hatch-${idx}`, mp.address);
}
await hatch(0); await hatch(1);

// ---------------------------------------------------------------------------
step("5. edit a pixel in leaf 0 and leaf 1");
const editedChunk = initialChunk(); editedChunk[0] = 0x11;   // (0, leaf-local row 0)
const editedCid = cidV1Raw(editedChunk);
async function edit(idx: number): Promise<void> {
    const leaf = queryUtxos(mp.address).find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === 1n && utxoDatumHex(u) === datumHex(leafDatum(idx, initialChunk())))!;
    const colDeed = findUtxoWithAsset(queryUtxos(dep.address), own.policyHex, colName)!;
    await signSubmitAwait({
        inputs: [{ utxo: leaf, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit([COL]) } }, work(ADA(100))],
        readonlyRefInputs: [colDeed],
        requiredSigners: [dep.pkh],
        collaterals: [coll],
        outputs: [{ address: mp.address, value: withAda(LEAF_ADA, mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(idx, editedChunk) }],
        changeAddress: dep.address,
    }, dep, `edit-${idx}`, mp.address);
}
await edit(0); await edit(1);

// ---------------------------------------------------------------------------
step("6. MULTI-LEAF commit adversarial attempts");
async function expectReject(label: string, mk: () => ITxBuildArgs): Promise<void> {
    let rejected = false, stage = "build";
    try {
        const tx = await txBuilder().build(mk());
        tx.signWith(dep.prv);
        stage = "submit";
        submitSignedTx(tx, `adv-${label}`);
    } catch { rejected = true; }
    assert(rejected, `"${label}" MUST be rejected but ACCEPTED (${stage})`);
    console.log(`  rejected at ${stage}: ${label} ✓`);
}
const leafEdited = (idx: number): UTxO => queryUtxos(mp.address).find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === 1n && utxoDatumHex(u) === datumHex(leafDatum(idx, editedChunk)))!;
const rootU = (): UTxO => findUtxoWithAsset(queryUtxos(mp.address), mp.policyHex, ROOT_REF_NFT_NAME)!;
const nurseryU = (): UTxO => queryUtxos(mp.address).find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === BigInt(N_LEAFS - 2))!;
// build a commit given ref-input utxos (ascending order assumed) + the new CID list
const commit = (refLeaves: UTxO[], newCids: Uint8Array[]): ITxBuildArgs => {
    const allRefs = [refM.utxoRef, ...refLeaves.map((l) => l.utxoRef)];
    const refIdxs = refLeaves.map((l) => sortedRefIndex(allRefs, l.utxoRef));
    return {
        inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit(refIdxs) } }, work(ADA(100))],
        readonlyRefInputs: refLeaves,
        collaterals: [coll],
        outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootDatum(newCids, bmp).data }],
        changeAddress: dep.address,
    };
};
const cidsWith = (...idxs: number[]): Uint8Array[] => initialLeafCids.map((c, i) => idxs.includes(i) ? editedCid : c);
{
    const l0 = () => leafEdited(0), l1 = () => leafEdited(1);

    // A) reference leaf 0 TWICE (duplicate)
    await expectReject("commit references the same leaf twice", () =>
        commit([l0(), l0()], cidsWith(0)));

    // B) reference the two leaves in NON-ASCENDING order (leaf1 before leaf0)
    await expectReject("commit lists leaves in non-ascending order", () => {
        // force the redeemer order [leaf1, leaf0] regardless of sorted positions
        const refLeaves = [l1(), l0()];
        const allRefs = [refM.utxoRef, ...refLeaves.map((l) => l.utxoRef)];
        const refIdxs = refLeaves.map((l) => sortedRefIndex(allRefs, l.utxoRef)); // [pos(leaf1), pos(leaf0)]
        return {
            inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit(refIdxs) } }, work(ADA(100))],
            readonlyRefInputs: refLeaves,
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootDatum(cidsWith(0, 1), bmp).data }],
            changeAddress: dep.address,
        };
    });

    // C) reference both, but write the WRONG CID at position 1 (leaf 1 keeps init)
    await expectReject("commit writes a wrong CID for a referenced leaf", () =>
        commit([l0(), l1()], cidsWith(0)));   // position 1 NOT updated though leaf 1 is referenced

    // D) reference ONLY leaf 0, but also change position 1 (unreferenced)
    await expectReject("commit changes a position whose leaf isn't referenced", () =>
        commit([l0()], cidsWith(0, 1)));

    // E) reference a NON-leaf input (the nursery) alongside a real leaf
    await expectReject("commit references a non-leaf input", () => {
        const refLeaves = [l0(), nurseryU()];  // nursery holds 82 markers, not 1
        const allRefs = [refM.utxoRef, ...refLeaves.map((l) => l.utxoRef)];
        // list order by ascending "idx": leaf0 (0) then nursery — force [pos(l0), pos(nursery)]
        const refIdxs = [sortedRefIndex(allRefs, refLeaves[0].utxoRef), sortedRefIndex(allRefs, refLeaves[1].utxoRef)];
        return {
            inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit(refIdxs) } }, work(ADA(100))],
            readonlyRefInputs: refLeaves,
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootDatum(cidsWith(0), bmp).data }],
            changeAddress: dep.address,
        };
    });

    console.log("  all multi-leaf commit attacks rejected ✓");

    // HONEST multi-leaf commit of BOTH leaves in one tx
    await signSubmitAwait(commit([l0(), l1()], cidsWith(0, 1)), dep, "honest-multicommit", mp.address);
    const rootAfter = rootU();
    assert.equal(utxoDatumHex(rootAfter), datumHex(rootDatum(cidsWith(0, 1), bmp).data), "root reflects both leaves");
    console.log("  honest multi-leaf commit of 2 leaves in ONE tx ✓");
}

console.log("\nMULTI-LEAF COMMIT ADVERSARIAL SUITE — ALL CHECKS PASSED ✓");
