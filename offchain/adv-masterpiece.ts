// ===========================================================================
//  Masterpiece (on-chain image) ADVERSARIAL suite.
//
//  Guarantees probed (each malicious tx REJECTED at build OR submit; honest
//  happy-paths must succeed on the real devnet node):
//    hatch  — peel EXACTLY one marker into a leaf holding the initial 0xFF
//             chunk at the right index; the rest continue in the nursery
//    edit   — only bytes inside a rect whose deed is referenced + signed may
//             change (boundary-exact; every listed rect must be owned)
//    commit — the new root must reflect the ACTUAL referenced leaf CID; the
//             root NFT stays on the config node
//    init   — one-shot: a second init cannot mint the genesis tokens
//
//  Run (devnet up):  npx tsx adv-masterpiece.ts
// ===========================================================================
import { Value, Hash28, dataToCbor, type Data, type UTxO, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, queryUtxos, awaitTxAtAddr, signSubmitAwait,
    sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, txBuilder, submitSignedTx, type Wallet,
} from "./lib.ts";
import {
    stewardshipContract, masterpieceContract, lockContract, lockedDatum, buildBmpHeader,
    rootDatum, leafDatum, nurseryDatum, initialChunk, freeDatum, lovelacePerPixelDatum,
    mpMintInit, mpHatch, mpEdit, mpCommit, oMintInit, oMintFree, oClaim,
    carveComplements, rectName, rectArea,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME,
    N_LEAFS, LINE_LENGTH, LOVELACE_PER_PIXEL, type Rect,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const step = (s: string): void => console.log(`\n== ${s} ==`);
const notRef = (x: { utxoRef: { toString(): string } }) =>
    (u: { utxoRef: { toString(): string } }): boolean => u.utxoRef.toString() !== x.utxoRef.toString();
const datumHex = (d: Data): string => dataToCbor(d).toString();
const utxoDatumHex = (u: UTxO): string | undefined =>
    u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;
type TokenEntry = [Uint8Array, bigint];
const tokens = (p: string, es: TokenEntry[]): Value => es.reduce((v, [n, a]) => Value.add(v, Value.singleAsset(new Hash28(p), n, a)), Value.zero);
const withAda = (l: bigint, p: string, es: TokenEntry[]): Value => Value.add(Value.lovelaces(l), tokens(p, es));
const CANVAS: Rect = { x0: 0, y0: 0, x1: 1008, y1: 1008 };

// ---------------------------------------------------------------------------
step("0. wallet + funding");
const dep: Wallet = ensureWallet(`advmp-${Date.now()}`);
const mallory: Wallet = ensureWallet(`advmp-mal-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: dep.address, lovelace: ADA(10) },
    { address: dep.address, lovelace: ADA(5) },
    { address: dep.address, lovelace: ADA(5) },
    { address: dep.address, lovelace: ADA(110) },
    { address: dep.address, lovelace: ADA(2000) },
    { address: mallory.address, lovelace: ADA(10) },
    { address: mallory.address, lovelace: ADA(100) },
], "fund-advmp");
awaitTxAtAddr(mallory.address, fundTx);
const dU = queryUtxos(dep.address);
const coll = dU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const fivers = dU.filter((u) => u.resolved.value.lovelaces === ADA(5));
const genesisO = fivers[0]!, genesisM = fivers[1]!;
const fundRef = dU.find((u) => u.resolved.value.lovelaces === ADA(110))!;
const fundWork = dU.find((u) => u.resolved.value.lovelaces === ADA(2000))!;
assert(coll && genesisO && genesisM && genesisO.utxoRef.toString() !== genesisM.utxoRef.toString() && fundRef && fundWork, "funding utxos");

const bmp = buildBmpHeader();
const own = stewardshipContract(dep.address, genesisO.utxoRef);
const mp = masterpieceContract(own.hash.toBuffer(), genesisM.utxoRef, bmp);
const lock = lockContract();
console.log("  stewardship:", own.policyHex, "\n  masterpiece:", mp.policyHex);

// ---------------------------------------------------------------------------
step("0b. deploy stewardship + masterpiece reference scripts");
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
const noRefs = (u: { utxoRef: { toString(): string } }): boolean =>
    u.utxoRef.toString() !== refO.utxoRef.toString() && u.utxoRef.toString() !== refM.utxoRef.toString();
const workUtxo = (min: bigint): UTxO => pureAdaUtxo(queryUtxos(dep.address).filter(noRefs).filter(notRef(coll)), min)!;

// ---------------------------------------------------------------------------
step("1. stewardship init + 2. masterpiece init");
{
    const gIdx = sortedRefIndex([genesisO.utxoRef, fundWork.utxoRef], genesisO.utxoRef);
    await signSubmitAwait({
        inputs: [genesisO, fundWork],
        collaterals: [coll],
        mints: [{ value: tokens(own.policyHex, [[FREE_TOKEN_NAME, 1n], [PRICE_NFT_NAME, 1n]]), script: { ref: refO, redeemer: oMintInit(gIdx) } }],
        outputs: [
            { address: own.address, value: withAda(ADA(3), own.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum(CANVAS) },
            { address: own.address, value: withAda(ADA(3), own.policyHex, [[PRICE_NFT_NAME, 1n]]), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: dep.address,
    }, dep, "stewardship-init", own.address);
}
const initCid = cidV1Raw(initialChunk());
const initialLeafCids = Array.from({ length: N_LEAFS }, () => initCid);
const rootD0 = rootDatum(initialLeafCids, bmp);
{
    const w = workUtxo(ADA(100));
    const ins = [genesisM, w];
    const gIdx = sortedRefIndex(ins.map((u) => u.utxoRef), genesisM.utxoRef);
    await signSubmitAwait({
        inputs: ins,
        collaterals: [coll],
        mints: [{ value: tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)], [ROOT_REF_NFT_NAME, 1n], [ROOT_USER_NFT_NAME, 1n]]), script: { ref: refM, redeemer: mpMintInit(gIdx) } }],
        outputs: [
            { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]]), datum: nurseryDatum(0) },
            { address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootD0.data },
            { address: dep.address, value: withAda(ADA(2), mp.policyHex, [[ROOT_USER_NFT_NAME, 1n]]) },
        ],
        changeAddress: dep.address,
    }, dep, "masterpiece-init", mp.address);
}

// reject harness
async function expectReject(label: string, mk: () => ITxBuildArgs, signer: Wallet): Promise<void> {
    let rejected = false, stage = "build";
    try {
        const tx = await txBuilder().build(mk());
        tx.signWith(signer.prv);
        stage = "submit";
        submitSignedTx(tx, `adv-${label}`);
    } catch { rejected = true; }
    assert(rejected, `"${label}" MUST be rejected but ACCEPTED (${stage})`);
    console.log(`  rejected at ${stage}: ${label} ✓`);
}
const nurseryOf = (nextIdx: number): UTxO => queryUtxos(mp.address).find((u) =>
    assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === BigInt(N_LEAFS - nextIdx) && utxoDatumHex(u) === datumHex(nurseryDatum(nextIdx)))!;

// ---------------------------------------------------------------------------
step("3. honest hatch leaf 0");
async function honestHatch(idx: number): Promise<void> {
    const rem = N_LEAFS - idx;
    await signSubmitAwait({
        inputs: [{ utxo: nurseryOf(idx), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } }, workUtxo(ADA(100))],
        collaterals: [coll],
        outputs: [
            { address: mp.address, value: withAda(ADA(70), mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(idx, initialChunk()) },
            { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(rem - 1)]]), datum: nurseryDatum(idx + 1) },
        ],
        changeAddress: dep.address,
    }, dep, `hatch-${idx}`, mp.address);
}
await honestHatch(0);
console.log("  leaf 0 hatched ✓");

// ---------------------------------------------------------------------------
step("4. HATCH adversarial attempts (nursery now at leaf 1)");
{
    const rem = N_LEAFS - 1;
    const base = (leafOut: any, nurseryMarkers: bigint, nurseryNext: number): ITxBuildArgs => ({
        inputs: [{ utxo: nurseryOf(1), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } }, workUtxo(ADA(100))],
        collaterals: [coll],
        outputs: [leafOut, { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, nurseryMarkers]]), datum: nurseryDatum(nurseryNext) }],
        changeAddress: dep.address,
    });

    // A) hatch a leaf holding a NON-0xFF chunk
    await expectReject("hatch a leaf with a tampered (non-0xFF) chunk", () => {
        const bad = initialChunk(); bad[0] = 0x00;
        return base({ address: mp.address, value: withAda(ADA(70), mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(1, bad) }, BigInt(rem - 1), 2);
    }, dep);

    // B) steal the leaf NFT to a wallet (leaf marker must stay at the script)
    await expectReject("hatch that sends the leaf NFT to a wallet", () => ({
        inputs: [{ utxo: nurseryOf(1), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } }, workUtxo(ADA(100))],
        collaterals: [coll],
        outputs: [
            { address: dep.address, value: withAda(ADA(70), mp.policyHex, [[LEAF_NFT_NAME, 1n]]) },  // leaf NFT to wallet
            { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(rem - 1)]]), datum: nurseryDatum(2) },
        ],
        changeAddress: dep.address,
    }), dep);

    // C) hatch with the WRONG leaf index
    await expectReject("hatch a leaf with the wrong index", () =>
        base({ address: mp.address, value: withAda(ADA(70), mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(5, initialChunk()) }, BigInt(rem - 1), 2), dep);

    // D) over-peel: put 2 markers on the leaf output (steal an extra marker)
    await expectReject("hatch that peels two markers into one leaf", () =>
        base({ address: mp.address, value: withAda(ADA(70), mp.policyHex, [[LEAF_NFT_NAME, 2n]]), datum: leafDatum(1, initialChunk()) }, BigInt(rem - 2), 2), dep);

    console.log("  all hatch attacks rejected ✓");
}

// ---------------------------------------------------------------------------
step("5. claim a deed over leaf-0 rows, then EDIT attacks");
const owned: Rect = { x0: 0, y0: 0, x1: 4, y1: 4 };   // within leaf 0 (rows 0..11)
const ownedName = rectName(owned);
{
    const free = queryUtxos(own.address);
    const freeNode = findUtxoWithAsset(free, own.policyHex, FREE_TOKEN_NAME)!;
    const priceCfg = findUtxoWithAsset(free, own.policyHex, PRICE_NFT_NAME)!;
    const comps = carveComplements(CANVAS, owned);
    await signSubmitAwait({
        inputs: [{ utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(owned) } }, workUtxo(ADA(200))],
        readonlyRefInputs: [priceCfg],
        collaterals: [coll],
        mints: [{ value: Value.add(Value.singleAsset(new Hash28(own.policyHex), ownedName, 1n), tokens(own.policyHex, [[FREE_TOKEN_NAME, BigInt(comps.length - 1)]])), script: { ref: refO, redeemer: oMintFree() } }],
        outputs: [
            ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), own.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum(r) })),
            { address: dep.address, value: Value.lovelaces(rectArea(owned) * LOVELACE_PER_PIXEL) },
            { address: dep.address, value: withAda(ADA(2), own.policyHex, [[ownedName, 1n]]) },
        ],
        changeAddress: dep.address,
    }, dep, "claim-owned", dep.address);
}
const deedU = (): UTxO => findUtxoWithAsset(queryUtxos(dep.address), own.policyHex, ownedName)!;
const leaf0U = (): UTxO => queryUtxos(mp.address).find((u) =>
    assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === 1n && utxoDatumHex(u) === datumHex(leafDatum(0, initialChunk())))!;

const editArgs = (chunk: Uint8Array, rects: Rect[], refDeeds: UTxO[], sign: boolean): ITxBuildArgs => ({
    inputs: [{ utxo: leaf0U(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit(rects) } }, workUtxo(ADA(100))],
    readonlyRefInputs: refDeeds,
    requiredSigners: sign ? [dep.pkh] : [],
    collaterals: [coll],
    outputs: [{ address: mp.address, value: withAda(ADA(70), mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(0, chunk) }],
    changeAddress: dep.address,
});
{
    // A) boundary off-by-one: paint pixel (4,0) — just OUTSIDE owned {0,0,4,4}
    await expectReject("edit one pixel past the owned rect's exclusive edge", () => {
        const c = initialChunk(); c[0 * LINE_LENGTH + 4] = 0x00;   // (x=4, y=0) ⊄ owned
        return editArgs(c, [owned], [deedU()], true);
    }, dep);

    // B) multi-rect: list an owned + an UNOWNED rect, change a pixel in the unowned one
    await expectReject("edit lists an unowned rect alongside the owned one", () => {
        const c = initialChunk(); c[0 * LINE_LENGTH + 100] = 0x00; // (x=100,y=0) in the unowned rect
        const unowned: Rect = { x0: 100, y0: 0, x1: 104, y1: 4 };
        return editArgs(c, [owned, unowned], [deedU()], true); // only the owned deed referenced
    }, dep);

    // HONEST edit: paint the owned 4x4 rect
    const editedChunk = initialChunk();
    for (let y = owned.y0; y < owned.y1; y++) for (let x = owned.x0; x < owned.x1; x++) editedChunk[y * LINE_LENGTH + x] = 0x00;
    await signSubmitAwait(editArgs(editedChunk, [owned], [deedU()], true), dep, "honest-edit", mp.address);
    console.log("  honest edit ✓");

    // ---------------------------------------------------------------------------
    step("6. COMMIT attacks + honest commit");
    const editedLeafCid = cidV1Raw(editedChunk);
    const goodLeafCids = [editedLeafCid, ...initialLeafCids.slice(1)];
    const editedLeaf = (): UTxO => queryUtxos(mp.address).find((u) =>
        assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === 1n && utxoDatumHex(u) === datumHex(leafDatum(0, editedChunk)))!;
    const rootU = (): UTxO => findUtxoWithAsset(queryUtxos(mp.address), mp.policyHex, ROOT_REF_NFT_NAME)!;
    const refIdxOf = (leaf: UTxO): number => sortedRefIndex([refM.utxoRef, leaf.utxoRef], leaf.utxoRef);

    // A) commit a root whose CIDs DON'T reflect the edited leaf (stale/hijack)
    await expectReject("commit a root that ignores the actual leaf CID", () => {
        const leaf = editedLeaf();
        const staleRoot = rootDatum(initialLeafCids, bmp); // pretends nothing changed
        return {
            inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit([refIdxOf(leaf)]) } }, workUtxo(ADA(100))],
            readonlyRefInputs: [leaf],
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: staleRoot.data }],
            changeAddress: dep.address,
        };
    }, dep);

    // B) move the root NFT to a wallet
    await expectReject("commit that moves the root NFT off the config node", () => {
        const leaf = editedLeaf();
        const goodRoot = rootDatum(goodLeafCids, bmp);
        return {
            inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit([refIdxOf(leaf)]) } }, workUtxo(ADA(100))],
            readonlyRefInputs: [leaf],
            collaterals: [coll],
            outputs: [{ address: dep.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: goodRoot.data }], // NFT to wallet
            changeAddress: dep.address,
        };
    }, dep);

    // C) reference a NON-leaf input as the committed leaf (the nursery)
    await expectReject("commit referencing a non-leaf input", () => {
        const nursery = nurseryOf(1);
        const goodRoot = rootDatum(goodLeafCids, bmp);
        return {
            inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit([refIdxOf(nursery)]) } }, workUtxo(ADA(100))],
            readonlyRefInputs: [nursery],
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: goodRoot.data }],
            changeAddress: dep.address,
        };
    }, dep);

    // HONEST commit
    {
        const leaf = editedLeaf();
        const goodRoot = rootDatum(goodLeafCids, bmp);
        await signSubmitAwait({
            inputs: [{ utxo: rootU(), referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit([refIdxOf(leaf)]) } }, workUtxo(ADA(100))],
            readonlyRefInputs: [leaf],
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: goodRoot.data }],
            changeAddress: dep.address,
        }, dep, "honest-commit", mp.address);
        assert.equal(utxoDatumHex(rootU()), datumHex(rootDatum(goodLeafCids, bmp).data), "root datum updated");
        console.log("  honest commit ✓ (image URI:", new TextDecoder().decode(rootDatum(goodLeafCids, bmp).uri) + ")");
    }
}

// ---------------------------------------------------------------------------
step("7. INIT is one-shot — a second masterpiece init must fail");
{
    // attempt to mint another full set of masterpiece tokens with a FRESH utxo
    // standing in for the (already-spent) genesis utxo
    await expectReject("re-run masterpiece init with a non-genesis utxo", () => {
        const w = workUtxo(ADA(100));
        return {
            inputs: [w],
            collaterals: [coll],
            mints: [{ value: tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)], [ROOT_REF_NFT_NAME, 1n], [ROOT_USER_NFT_NAME, 1n]]), script: { ref: refM, redeemer: mpMintInit(0) } }],
            outputs: [
                { address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]]), datum: nurseryDatum(0) },
                { address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootD0.data },
                { address: dep.address, value: withAda(ADA(2), mp.policyHex, [[ROOT_USER_NFT_NAME, 1n]]) },
            ],
            changeAddress: dep.address,
        };
    }, dep);
    console.log("  second init rejected ✓");
}

console.log("\nMASTERPIECE ADVERSARIAL SUITE — ALL CHECKS PASSED ✓");
