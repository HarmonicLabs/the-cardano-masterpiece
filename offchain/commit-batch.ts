// ===========================================================================
//  EXPERIMENT: how many leaves fit in ONE multi-leaf commit tx?
//
//  Deploy a fresh instance on the devnet, hatch all 84 leaves, edit one pixel
//  in EVERY leaf (a full-height 1-px owned column lets a single deed authorize
//  a pixel in each leaf), then build the LARGEST single `commit` tx that still
//  builds (buildooor evaluates the script — so success ⇒ within tx-size AND
//  ex-unit budget) and submit it to confirm the node agrees.
//
//  Run (devnet up):  npx tsx commit-batch.ts
// ===========================================================================
import { Value, Hash28, UTxO, TxOutRef, dataToCbor, type Data, type ITxBuildArgs } from "@harmoniclabs/buildooor";
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
const LEAF_ADA = ADA(60);   // >= the 12 KB-datum min-utxo (~55 ADA)
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
const chainedOut = (tx: { hash: { toString(): string }; body: { outputs: any[] } }, i: number): UTxO =>
    new UTxO({ utxoRef: new TxOutRef({ id: tx.hash.toString(), index: i }), resolved: tx.body.outputs[i] });

// ---------------------------------------------------------------------------
step("0. wallet + funding");
const dep: Wallet = ensureWallet(`cb-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: dep.address, lovelace: ADA(10) },     // collateral
    { address: dep.address, lovelace: ADA(5) },      // stewardship genesis
    { address: dep.address, lovelace: ADA(5) },      // masterpiece genesis
    { address: dep.address, lovelace: ADA(110) },    // ref deploys
    { address: dep.address, lovelace: ADA(6000) },   // hatch funds (parks ~60/leaf)
    { address: dep.address, lovelace: ADA(300) },    // working funds (claim/edit/commit fees)
], "fund-cb");
awaitTxAtAddr(dep.address, fundTx);
const dU = queryUtxos(dep.address);
const coll = dU.find((u) => u.resolved.value.lovelaces === ADA(10))!;
const fivers = dU.filter((u) => u.resolved.value.lovelaces === ADA(5));
const genesisO = fivers[0]!, genesisM = fivers[1]!;
const fundRef = dU.find((u) => u.resolved.value.lovelaces === ADA(110))!;
const fundHatch = dU.find((u) => u.resolved.value.lovelaces === ADA(6000))!;
assert(coll && genesisO && genesisM && genesisO.utxoRef.toString() !== genesisM.utxoRef.toString() && fundRef && fundHatch, "funding utxos");

const bmp = buildBmpHeader();
const own = stewardshipContract(dep.address, genesisO.utxoRef);   // protocolSteward = dep
const mp = masterpieceContract(own.hash.toBuffer(), genesisM.utxoRef, bmp);
const lock = lockContract();
const work = (min: bigint): UTxO => pureAdaUtxo(queryUtxos(dep.address).filter(notRef(coll)).filter(notRef(fundRef)).filter(notRef(fundHatch)), min)!;
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
step("3. stewardClaim a full-height 1-px column (one owned pixel in every leaf)");
const COL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1008 };
const colName = rectName(COL);
{
    const free = queryUtxos(own.address);
    const freeNode = findUtxoWithAsset(free, own.policyHex, FREE_TOKEN_NAME)!;
    const comps = carveComplements(CANVAS, COL); // [ right {1,0,1008,1008} ]
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
    console.log("  owns column (0,0)-(1,1008) ✓");
}

// ---------------------------------------------------------------------------
step(`4. hatch all ${N_LEAFS} leaves (mempool-chained)`);
{
    let nursery = queryUtxos(mp.address).find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === BigInt(N_LEAFS))!;
    let fund = fundHatch;
    const txb = await txBuilder();
    for (let leaf = 0; leaf < N_LEAFS; leaf++) {
        const last = leaf === N_LEAFS - 1;
        const tx = await txb.build({
            inputs: [{ utxo: nursery, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } }, fund],
            collaterals: [coll],
            outputs: [
                { address: mp.address, value: withAda(LEAF_ADA, mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(leaf, initialChunk()) },
                ...(last ? [] : [{ address: mp.address, value: withAda(ADA(15), mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS - leaf - 1)]]), datum: nurseryDatum(leaf + 1) }]),
            ],
            changeAddress: dep.address,
        });
        tx.signWith(dep.prv);
        await submitSignedTx(tx, `hatch-${leaf}`);
        if (!last) nursery = chainedOut(tx, 1);
        fund = chainedOut(tx, tx.body.outputs.length - 1);
        if (leaf % 10 === 9 || last) { awaitTxAtAddr(mp.address, tx.hash.toString()); console.log(`  hatched through leaf ${leaf} ✓`); }
    }
}

// ---------------------------------------------------------------------------
step(`5. edit one pixel (0, 12·idx) in every leaf (mempool-chained)`);
const editedChunk = initialChunk(); editedChunk[0] = 0x11;   // pixel (0, leaf-local row 0)
const editedCid = cidV1Raw(editedChunk);
{
    const mpU = queryUtxos(mp.address);
    const leafByIdx: UTxO[] = [];
    for (let i = 0; i < N_LEAFS; i++)
        leafByIdx[i] = mpU.find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === 1n && utxoDatumHex(u) === datumHex(leafDatum(i, initialChunk())))!;
    assert(leafByIdx.every(Boolean), "all 84 leaves located");
    const colDeed = findUtxoWithAsset(queryUtxos(dep.address), own.policyHex, colName)!;
    let fund = work(ADA(150));
    const txb = await txBuilder();
    for (let i = 0; i < N_LEAFS; i++) {
        const tx = await txb.build({
            inputs: [{ utxo: leafByIdx[i], referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit([COL]) } }, fund],
            readonlyRefInputs: [colDeed],
            requiredSigners: [dep.pkh],
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(LEAF_ADA, mp.policyHex, [[LEAF_NFT_NAME, 1n]]), datum: leafDatum(i, editedChunk) }],
            changeAddress: dep.address,
        });
        tx.signWith(dep.prv);
        await submitSignedTx(tx, `edit-${i}`);
        fund = chainedOut(tx, tx.body.outputs.length - 1);
        if (i % 10 === 9 || i === N_LEAFS - 1) { awaitTxAtAddr(mp.address, tx.hash.toString()); console.log(`  edited through leaf ${i} ✓`); }
    }
}

// ---------------------------------------------------------------------------
// buildooor's build does NOT enforce the node's ex-unit budget, so we ask the
// NODE: submit descending K until one is accepted. A rejected submit never
// enters the mempool, so the root utxo is untouched and the next K reuses it.
step("6. find the LARGEST commit the NODE accepts (submit descending)");
{
    const mpU = queryUtxos(mp.address);
    const editedLeaves: UTxO[] = [];   // idx-ascending
    for (let i = 0; i < N_LEAFS; i++)
        editedLeaves[i] = mpU.find((u) => assetAmount(u, mp.policyHex, LEAF_NFT_NAME) === 1n && utxoDatumHex(u) === datumHex(leafDatum(i, editedChunk)))!;
    assert(editedLeaves.every(Boolean), "all 84 edited leaves located");
    const root = findUtxoWithAsset(mpU, mp.policyHex, ROOT_REF_NFT_NAME)!;

    const commitArgs = (K: number): ITxBuildArgs => {
        const committed = editedLeaves.slice(0, K);            // leaves 0..K-1
        const allRefs = [refM.utxoRef, ...committed.map((l) => l.utxoRef)];
        const refIdxs = committed.map((l) => sortedRefIndex(allRefs, l.utxoRef)); // ascending leaf idx order
        const newCids = initialLeafCids.map((c, i) => i < K ? editedCid : c);
        return {
            inputs: [{ utxo: root, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit(refIdxs) } }, work(ADA(200))],
            readonlyRefInputs: committed,
            collaterals: [coll],
            outputs: [{ address: mp.address, value: withAda(ADA(30), mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootDatum(newCids, bmp).data }],
            changeAddress: dep.address,
        };
    };
    const exUnitsOf = (tx: any): { mem: bigint; cpu: bigint } => {
        let mem = 0n, cpu = 0n;
        const rs = tx?.witnessSet?.redeemers ?? tx?.body?.redeemers ?? [];
        for (const r of rs) {
            const e = r?.execUnits ?? r?.exUnits ?? r;
            mem += BigInt(Math.round(Number(e?.mem ?? e?.memory ?? 0)));
            cpu += BigInt(Math.round(Number(e?.cpu ?? e?.steps ?? 0)));
        }
        return { mem, cpu };
    };

    let maxK = 0, acceptedHash = "";
    for (let K = N_LEAFS; K >= 1; K--) {
        let tx: any;
        try { tx = await (await txBuilder()).build(commitArgs(K)); }
        catch (e) { console.log(`  K=${K}: BUILD failed — ${String((e as Error).message).split("\n")[0].slice(0, 90)}`); continue; }
        const size = tx.toCborBytes().length;
        const { mem, cpu } = exUnitsOf(tx);
        tx.signWith(dep.prv);
        try {
            acceptedHash = await submitSignedTx(tx, `commit-${K}`);
            maxK = K;
            console.log(`  K=${K}: ACCEPTED ✓  tx=${size}B  mem=${mem}  cpu=${cpu}`);
            break;
        } catch (e) {
            const msg = String((e as Error).message ?? e).replace(/\s+/g, " ");
            const why = msg.match(/ExUnitsTooBig[^)]*\)?|MaxTxSizeUTxO[^)]*\)?|TooBig[^)]*\)?|FeeTooSmall[^)]*\)?/i)?.[0] ?? msg.slice(0, 150);
            console.log(`  K=${K}: REJECTED  tx=${size}B  mem=${mem}  cpu=${cpu}  — ${why}`);
        }
    }
    assert(maxK > 0, "no commit accepted by the node");
    console.log(`\n  >>> LARGEST single commit the node accepts: ${maxK} of ${N_LEAFS} leaves`);

    awaitTxAtAddr(mp.address, acceptedHash);
    const rootAfter = findUtxoWithAsset(queryUtxos(mp.address), mp.policyHex, ROOT_REF_NFT_NAME)!;
    const expected = rootDatum(initialLeafCids.map((c, i) => i < maxK ? editedCid : c), bmp).data;
    assert.equal(utxoDatumHex(rootAfter), datumHex(expected), "root reflects the committed leaves");
    console.log(`  root updated: ${maxK} leaves committed in ONE tx ✓`);
}

console.log("\nCOMMIT-BATCH EXPERIMENT DONE ✓");
