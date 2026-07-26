// ===========================================================================
//  End-to-end protocol test — BACKEND=devnet (default) or BACKEND=preprod.
//
//  Flow:
//   0. wallet + funding (devnet: genesis faucet; preprod: keys/ + self-split)
//   1. deploy both scripts as reference scripts (one tx each: 16KB limit)
//   2. ownership init   (mint the FREE marker, whole-canvas free node)
//   3. masterpiece init (mint (100)/(222)/128 leaf markers -> nursery + root)
//   4. hatch leaf 0 and leaf 1
//   5. claim rect (0,0)-(2,2)  (pays 20 ada to protocolOwner = deployer)
//   6. edit leaf 0 within the claimed rect (ref-input NFT + signature)
//   7. commit leaf 0 into the root (whole-image CID + CIP-68 image update)
//
//  No IPFS uploads: CIDs are computed locally only to build datums.
// ===========================================================================
import {
    Address, Value, Hash28, UTxO, TxOutRef, DataConstr, DataI, dataToCbor, type Data, type ITxBuildArgs,
} from "@harmoniclabs/buildooor";
import {
    ensureWallet, fundFromGenesis, sortedRefIndex,
    findUtxoWithAsset, assetAmount, type Wallet,
} from "./lib.ts";
import { getProvider, loadPreprodWallet, type ChainProvider } from "./provider.ts";
import {
    ownershipContract, masterpieceContract, lockContract, lockedDatum, buildBmpHeader,
    rootDatum, leafDatum, nurseryDatum, initialChunk, freeDatum, lovelacePerPixelDatum,
    rectName, rectArea,
    mpMintInit, mpCommit, mpEdit, mpHatch,
    oMintInit, oMintFree, oClaim, oPriceChange,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME,
    N_LEAFS, LINE_LENGTH, LOVELACE_PER_PIXEL,
    type Rect,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";
import assert from "node:assert";

const ADA = (n: number | bigint): bigint => BigInt(n) * 1_000_000n;

type TokenEntry = [name: Uint8Array, amount: bigint];
const tokens = (policyHex: string, entries: TokenEntry[]): Value =>
    entries.reduce((v, [name, amt]) =>
        Value.add(v, Value.singleAsset(new Hash28(policyHex), name, amt)), Value.zero);
const withAda = (lovelace: bigint, policyHex: string, entries: TokenEntry[]): Value =>
    Value.add(Value.lovelaces(lovelace), tokens(policyHex, entries));

const datumHex = (d: Data): string => dataToCbor(d).toString();
const utxoDatumHex = (u: UTxO): string | undefined =>
    u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;

function step(name: string): void { console.log(`\n== ${name} ==`); }

const provider: ChainProvider = getProvider();
console.log(`backend: ${provider.backend}`);

async function sendTx(
    args: ITxBuildArgs, wallet: Wallet, label: string, waitAddr?: string
): Promise<string> {
    const txb = await provider.txBuilder();
    const tx = await txb.build(args);
    tx.signWith(wallet.prv);
    const h = await provider.submit(tx, label);
    console.log(`  [${label}] submitted ${h}`);
    if (waitAddr) await provider.awaitTx(waitAddr, h);
    return h;
}

const byRef = (utxos: UTxO[], txid: string, ix: number): UTxO | undefined =>
    utxos.find((u) => u.utxoRef.id.toString() === txid && Number(u.utxoRef.index) === ix);

// ---------------------------------------------------------------------------
// 0. wallet + funding
// ---------------------------------------------------------------------------
step("0. wallet + funding");
const deployer: Wallet = provider.backend === "preprod"
    ? loadPreprodWallet()
    // fresh wallet per devnet run: every e2e is fully self-contained
    : ensureWallet(`deployer-${Date.now()}`);
console.log("  deployer:", deployer.address.toString());
const deployerAddr = deployer.address.toString();

// dedicated utxo layout for the run, selected by (txid, index) of the split
// tx: [0]=collateral 10, [1]=ownership genesis 5, [2]=masterpiece genesis 5,
// [3],[4]=working funds
let splitTxId: string;
if (provider.backend === "devnet") {
    splitTxId = fundFromGenesis([
        { address: deployer.address, lovelace: ADA(10) },
        { address: deployer.address, lovelace: ADA(5) },
        { address: deployer.address, lovelace: ADA(5) },
        { address: deployer.address, lovelace: ADA(2000) },
        { address: deployer.address, lovelace: ADA(7000) },
    ], "fund-deployer");
} else {
    // preprod: split our own funds (fresh labeled utxos every run)
    const utxos = await provider.queryUtxos(deployerAddr);
    const pure = utxos.filter((u) => {
        const j = u.resolved.value.toJson() as Record<string, unknown>;
        return Object.keys(j).length === 1 && u.resolved.value.lovelaces >= ADA(50);
    }).sort((a, b) => Number(b.resolved.value.lovelaces - a.resolved.value.lovelaces));
    assert(pure.length > 0, "preprod wallet has no usable pure-ada utxo — fund keys/preprod.addr");
    splitTxId = await sendTx({
        inputs: [pure[0]],
        outputs: [
            { address: deployer.address, value: Value.lovelaces(ADA(10)) },
            { address: deployer.address, value: Value.lovelaces(ADA(5)) },
            { address: deployer.address, value: Value.lovelaces(ADA(5)) },
            { address: deployer.address, value: Value.lovelaces(ADA(600)) },
            { address: deployer.address, value: Value.lovelaces(ADA(600)) },
        ],
        changeAddress: deployer.address,
    }, deployer, "fund-split");
}
await provider.awaitTx(deployerAddr, splitTxId);
console.log("  funded:", splitTxId);

let myUtxos = await provider.queryUtxos(deployerAddr);
const collateralU = byRef(myUtxos, splitTxId, 0)!;
const genesisO = byRef(myUtxos, splitTxId, 1)!;
const genesisM = byRef(myUtxos, splitTxId, 2)!;
const fundA = byRef(myUtxos, splitTxId, 3)!;
const fundB = byRef(myUtxos, splitTxId, 4)!;
assert(collateralU && genesisO && genesisM && fundA && fundB, "expected the 5 funding utxos");

// ---------------------------------------------------------------------------
// contracts (parameterized by the genesis refs picked above)
// ---------------------------------------------------------------------------
const bmpHeader = buildBmpHeader();
// protocol owner: PROTOCOL_OWNER env overrides (receives 5₳/px payments and
// can ownerClaim); defaults to the deployer for self-contained test runs
const protocolOwner = process.env.PROTOCOL_OWNER
    ? Address.fromString(process.env.PROTOCOL_OWNER)
    : deployer.address;
console.log("  protocol owner    :", protocolOwner.toString());
const ownership = ownershipContract(protocolOwner, genesisO.utxoRef);
const masterpiece = masterpieceContract(ownership.hash.toBuffer(), genesisM.utxoRef, bmpHeader);
const ownershipAddr = ownership.address.toString();
const masterpieceAddr = masterpiece.address.toString();
const lock = lockContract();
console.log("  ownership policy  :", ownership.policyHex);
console.log("  masterpiece policy:", masterpiece.policyHex);
console.log("  lock (refs park)  :", lock.address.toString());

// ---------------------------------------------------------------------------
// 1. deploy reference scripts (one tx per script: both no longer fit 16KB)
// ---------------------------------------------------------------------------
step("1. deploy reference scripts");
const deployOHash = await sendTx({
    inputs: [fundA],
    outputs: [
        // parked at the Lock address: PERMANENTLY unspendable, deployment
        // can never be destroyed (deposit is locked forever)
        { address: lock.address, value: Value.lovelaces(ADA(35)), refScript: ownership.script, datum: lockedDatum() },
    ],
    changeAddress: deployer.address,
}, deployer, "deploy-ref-ownership", deployerAddr);
const afterDeployO = await provider.queryUtxos(deployerAddr);
const deployMHash = await sendTx({
    inputs: [byRef(afterDeployO, deployOHash, 1)!], // change of the previous tx
    outputs: [
        { address: lock.address, value: Value.lovelaces(ADA(60)), refScript: masterpiece.script, datum: lockedDatum() },
    ],
    changeAddress: deployer.address,
}, deployer, "deploy-ref-masterpiece", deployerAddr);

const all = await provider.queryUtxos(lock.address.toString());
const refO = byRef(all, deployOHash, 0)!;
const refM = byRef(all, deployMHash, 0)!;
assert(refO && refM, "reference script utxos");

// ---------------------------------------------------------------------------
// 2. ownership init
// ---------------------------------------------------------------------------
step("2. ownership init");
{
    const gIdx = sortedRefIndex([genesisO.utxoRef, fundB.utxoRef], genesisO.utxoRef);
    await sendTx({
        inputs: [genesisO, fundB],
        collaterals: [collateralU],
        mints: [{
            value: tokens(ownership.policyHex, [[FREE_TOKEN_NAME, 1n], [PRICE_NFT_NAME, 1n]]),
            script: { ref: refO, redeemer: oMintInit(gIdx) },
        }],
        outputs: [
            {
                address: ownership.address,
                value: withAda(ADA(3), ownership.policyHex, [[FREE_TOKEN_NAME, 1n]]),
                datum: freeDatum({ x0: 0, y0: 0, x1: 1008, y1: 1008 }),
            },
            { // the price config node: unique NFT + initial lovelace-per-pixel
                address: ownership.address,
                value: withAda(ADA(3), ownership.policyHex, [[PRICE_NFT_NAME, 1n]]),
                datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL),
            },
        ],
        changeAddress: deployer.address,
    }, deployer, "ownership-init", ownershipAddr);
    const free = (await provider.queryUtxos(ownershipAddr))
        .filter((u) => assetAmount(u, ownership.policyHex, FREE_TOKEN_NAME) === 1n);
    assert.equal(free.length, 1, "one free node");
    assert.equal(assetAmount(free[0], ownership.policyHex, FREE_TOKEN_NAME), 1n, "free marker minted");
    console.log("  free node covers whole canvas ✓");
}

// ---------------------------------------------------------------------------
// 3. masterpiece init
// ---------------------------------------------------------------------------
step("3. masterpiece init");
const initCid = cidV1Raw(initialChunk());
const initialLeafCids: Uint8Array[] = Array.from({ length: N_LEAFS }, () => initCid);
const rootD0 = rootDatum(initialLeafCids, bmpHeader);
{
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(100)
        && u.utxoRef.toString() !== refO.utxoRef.toString()
        && u.utxoRef.toString() !== refM.utxoRef.toString());
    const ins = [genesisM, wall[0]];
    const gIdx = sortedRefIndex(ins.map((u) => u.utxoRef), genesisM.utxoRef);
    await sendTx({
        inputs: ins,
        collaterals: [collateralU],
        mints: [{
            value: tokens(masterpiece.policyHex, [
                [LEAF_NFT_NAME, BigInt(N_LEAFS)],
                [ROOT_REF_NFT_NAME, 1n],
                [ROOT_USER_NFT_NAME, 1n],
            ]),
            script: { ref: refM, redeemer: mpMintInit(gIdx) },
        }],
        outputs: [
            { // nursery: all 128 leaf markers
                address: masterpiece.address,
                value: withAda(ADA(15), masterpiece.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]]),
                datum: nurseryDatum(0),
            },
            { // CIP-68 reference NFT + root datum
                address: masterpiece.address,
                value: withAda(ADA(30), masterpiece.policyHex, [[ROOT_REF_NFT_NAME, 1n]]),
                datum: rootD0.data,
            },
            { // (222) user token to the deployer
                address: deployer.address,
                value: withAda(ADA(2), masterpiece.policyHex, [[ROOT_USER_NFT_NAME, 1n]]),
            },
        ],
        changeAddress: deployer.address,
    }, deployer, "masterpiece-init", masterpieceAddr);
    const mp = await provider.queryUtxos(masterpieceAddr);
    assert(findUtxoWithAsset(mp, masterpiece.policyHex, ROOT_REF_NFT_NAME), "root (100) locked");
    console.log("  initial image uri:", new TextDecoder().decode(rootD0.uri));
}

// ---------------------------------------------------------------------------
// 4. hatch leaves — 0,1 by default; ALL 128 with HATCH_ALL=1 (mempool-chained:
// each hatch spends the PREDICTED nursery + change outputs of the previous
// one, awaiting confirmation only every 10 txs)
// ---------------------------------------------------------------------------
const N_HATCH = process.env.HATCH_ALL ? N_LEAFS : 2;
step(`4. hatch leaves 0..${N_HATCH - 1}`);
if (process.env.HATCH_ALL) {
    const mp0 = await provider.queryUtxos(masterpieceAddr);
    let nursery = mp0.find((u) =>
        assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) === BigInt(N_LEAFS))!;
    assert(nursery, "full nursery present");
    let wall = (await provider.queryUtxos(deployerAddr))
        .filter((u) => u.resolved.value.lovelaces >= ADA(6000) && u.resolved.refScript === undefined)[0]!;
    assert(wall, "a single utxo big enough to fund all hatches");
    const txb = await provider.txBuilder();
    for (let leaf = 0; leaf < N_LEAFS; leaf++) {
        const last = leaf === N_LEAFS - 1;
        const tx = await txb.build({
            inputs: [
                { utxo: nursery, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } },
                wall,
            ],
            collaterals: [collateralU],
            outputs: [
                { // the hatched leaf FIRST (validator expects marker-outs order [leaf, nursery])
                    address: masterpiece.address,
                    value: withAda(ADA(70), masterpiece.policyHex, [[LEAF_NFT_NAME, 1n]]),
                    datum: leafDatum(leaf, initialChunk()),
                },
                ...(last ? [] : [{ // continuing nursery (none on the final hatch)
                    address: masterpiece.address,
                    value: withAda(ADA(15), masterpiece.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS - leaf - 1)]]),
                    datum: nurseryDatum(leaf + 1),
                }]),
            ],
            changeAddress: deployer.address,
        });
        tx.signWith(deployer.prv);
        await provider.submit(tx, `hatch-${leaf}`);
        const outs = tx.body.outputs;
        if (!last) nursery = new UTxO({
            utxoRef: new TxOutRef({ id: tx.hash.toString(), index: 1 }), resolved: outs[1] });
        wall = new UTxO({
            utxoRef: new TxOutRef({ id: tx.hash.toString(), index: outs.length - 1 }),
            resolved: outs[outs.length - 1] });
        if (leaf % 10 === 9 || last) {
            await provider.awaitTx(masterpieceAddr, tx.hash.toString());
            console.log(`  leaves 0..${leaf} hatched ✓`);
        }
    }
    const mp = await provider.queryUtxos(masterpieceAddr);
    const leaves = mp.filter((u) => assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) === 1n);
    assert(leaves.length === N_LEAFS, `expected ${N_LEAFS} leaf utxos, got ${leaves.length}`);
    assert(!mp.some((u) => assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) > 1n),
        "nursery fully drained");
    console.log(`  ALL ${N_LEAFS} leaves hatched, nursery drained ✓`);
} else
for (let leaf = 0; leaf < 2; leaf++) {
    const mp = await provider.queryUtxos(masterpieceAddr);
    const nursery = mp.find((u) =>
        assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) === BigInt(N_LEAFS - leaf));
    assert(nursery, `nursery with ${N_LEAFS - leaf} markers`);
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(100));
    await sendTx({
        inputs: [
            { utxo: nursery, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } },
            wall[0],
        ],
        collaterals: [collateralU],
        outputs: [
            { // the hatched leaf FIRST (validator expects marker-outs order [leaf, nursery])
                address: masterpiece.address,
                value: withAda(ADA(70), masterpiece.policyHex, [[LEAF_NFT_NAME, 1n]]),
                datum: leafDatum(leaf, initialChunk()),
            },
            { // continuing nursery
                address: masterpiece.address,
                value: withAda(ADA(15), masterpiece.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS - leaf - 1)]]),
                datum: nurseryDatum(leaf + 1),
            },
        ],
        changeAddress: deployer.address,
    }, deployer, `hatch-${leaf}`, masterpieceAddr);
    console.log(`  leaf ${leaf} hatched ✓`);
}

// ---------------------------------------------------------------------------
// DEPLOY_ONLY=1: stop here — protocol deployed and hatched, canvas untouched
// (no claims, no edits, no commit)
// ---------------------------------------------------------------------------
if (process.env.DEPLOY_ONLY) {
    console.log("\nDEPLOY-ONLY DONE ✓ (no claims made)");
    console.log("  ownership policy   :", ownership.policyHex);
    console.log("  ownership address  :", ownershipAddr);
    console.log("  masterpiece policy :", masterpiece.policyHex);
    console.log("  masterpiece address:", masterpieceAddr);
    console.log("  ownership ref      :", `${deployOHash}#0`);
    console.log("  masterpiece ref    :", `${deployMHash}#0`);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// 5. claim rect (0,0)-(2,2)
// ---------------------------------------------------------------------------
step("5. claim (0,0)-(2,2)");
const claimed: Rect = { x0: 0, y0: 0, x1: 2, y1: 2 };
const claimedName = rectName(claimed);
{
    const free = await provider.queryUtxos(ownershipAddr);
    const freeNode = findUtxoWithAsset(free, ownership.policyHex, FREE_TOKEN_NAME);
    assert(freeNode, "free node present");
    const priceCfg = findUtxoWithAsset(free, ownership.policyHex, PRICE_NFT_NAME);
    assert(priceCfg, "price config node present");
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(100));
    const price = rectArea(claimed) * LOVELACE_PER_PIXEL; // 4 px -> 20 ada

    // guillotine complements of claimed in the whole canvas, validator order:
    // top(none) / bottom / left(none) / right
    const bottom: Rect = { x0: 0, y0: 2, x1: 1008, y1: 1008 };
    const right: Rect = { x0: 2, y0: 0, x1: 1008, y1: 2 };

    await sendTx({
        inputs: [
            { utxo: freeNode, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oClaim(claimed) } },
            wall[0],
        ],
        // the price lives on the config node — referenced (NFT-validated), not spent
        readonlyRefInputs: [priceCfg],
        collaterals: [collateralU],
        mints: [{
            // exact mint: OwnerNft +1, FREE marker k-1 = +1 (2 complements)
            value: tokens(ownership.policyHex, [[claimedName, 1n], [FREE_TOKEN_NAME, 1n]]),
            script: { ref: refO, redeemer: oMintFree() },
        }],
        outputs: [
            { address: ownership.address, value: withAda(ADA(3), ownership.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum(bottom) },
            { address: ownership.address, value: withAda(ADA(3), ownership.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum(right) },
            { address: deployer.address, value: Value.lovelaces(price) }, // protocolOwner payment
            { address: deployer.address, value: withAda(ADA(2), ownership.policyHex, [[claimedName, 1n]]) }, // the deed
        ],
        changeAddress: deployer.address,
    }, deployer, "claim", ownershipAddr);

    const freeAfter = (await provider.queryUtxos(ownershipAddr))
        .filter((u) => assetAmount(u, ownership.policyHex, FREE_TOKEN_NAME) === 1n);
    assert.equal(freeAfter.length, 2, "two complement free nodes");
    const deed = findUtxoWithAsset(await provider.queryUtxos(deployerAddr), ownership.policyHex, claimedName);
    assert(deed, "owner NFT in wallet");
    console.log(`  owner NFT "${new TextDecoder().decode(claimedName)}" claimed ✓`);
}

// ---------------------------------------------------------------------------
// 5b. protocol owner retunes the price per pixel (LovelacePerPixel.change)
// ---------------------------------------------------------------------------
step("5b. owner changes price per pixel");
{
    const newPrice = 7_000_000n; // 5 -> 7 ADA/px
    const cfg = findUtxoWithAsset(await provider.queryUtxos(ownershipAddr), ownership.policyHex, PRICE_NFT_NAME);
    assert(cfg, "price config present");
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(20) && u.resolved.refScript === undefined)[0];
    await sendTx({
        inputs: [
            { utxo: cfg!, referenceScript: { refUtxo: refO, datum: "inline", redeemer: oPriceChange() } },
            wall,
        ],
        collaterals: [collateralU],
        requiredSigners: [deployer.pkh],
        outputs: [{
            address: ownership.address,
            value: withAda(ADA(3), ownership.policyHex, [[PRICE_NFT_NAME, 1n]]),
            datum: lovelacePerPixelDatum(newPrice),
        }],
        changeAddress: deployer.address,
    }, deployer, "price-change", ownershipAddr);

    const cfgAfter = findUtxoWithAsset(await provider.queryUtxos(ownershipAddr), ownership.policyHex, PRICE_NFT_NAME);
    assert(cfgAfter, "price config still present after change");
    const pd = cfgAfter!.resolved.datum as DataConstr;
    assert.equal(Number(pd.constr), 1, "LovelacePerPixel datum");
    assert.equal((pd.fields[0] as DataI).int, newPrice, "price updated to 7 ADA/px");
    console.log(`  price changed 5 -> 7 ADA/px, NFT preserved ✓`);
}

// ---------------------------------------------------------------------------
// 6. edit leaf 0 (paint the claimed 2x2 black)
// ---------------------------------------------------------------------------
step("6. edit leaf 0");
const newChunk = initialChunk();
for (let y = claimed.y0; y < claimed.y1; y++)
    for (let x = claimed.x0; x < claimed.x1; x++)
        newChunk[y * LINE_LENGTH + x] = 0x00;
const newLeafCid = cidV1Raw(newChunk);
{
    const mp = await provider.queryUtxos(masterpieceAddr);
    const leaf0 = mp.find((u) =>
        assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) === 1n
        && utxoDatumHex(u) === datumHex(leafDatum(0, initialChunk())));
    assert(leaf0, "leaf 0 utxo");
    const deed = findUtxoWithAsset(await provider.queryUtxos(deployerAddr), ownership.policyHex, claimedName);
    assert(deed, "deed utxo");
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(100)
        && u.utxoRef.toString() !== deed.utxoRef.toString());

    await sendTx({
        inputs: [
            { utxo: leaf0, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit([claimed]) } },
            wall[0],
        ],
        readonlyRefInputs: [deed],
        requiredSigners: [deployer.pkh],
        collaterals: [collateralU],
        outputs: [{
            address: masterpiece.address,
            value: withAda(ADA(70), masterpiece.policyHex, [[LEAF_NFT_NAME, 1n]]),
            datum: leafDatum(0, newChunk),
        }],
        changeAddress: deployer.address,
    }, deployer, "edit-leaf0", masterpieceAddr);
    console.log("  leaf 0 edited (2x2 painted) ✓");
}

// ---------------------------------------------------------------------------
// 6b. ADVERSARIAL: you cannot change bytes you don't hold the OwnerNft of.
// Build-only (buildooor runs the validator during build), so these never
// touch chain state — they must all be REJECTED by the edit validator.
// ---------------------------------------------------------------------------
step("6b. ADVERSARIAL edits must fail");
{
    const mp = await provider.queryUtxos(masterpieceAddr);
    const leaf0 = mp.find((u) =>
        assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) === 1n
        && utxoDatumHex(u) === datumHex(leafDatum(0, newChunk)));   // the just-edited leaf 0
    assert(leaf0, "current leaf 0");
    const deed = findUtxoWithAsset(await provider.queryUtxos(deployerAddr), ownership.policyHex, claimedName)!;
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(100) && u.utxoRef.toString() !== deed.utxoRef.toString());

    const attempt = async (
        label: string, mutate: (c: Uint8Array) => void, ownerRects: Rect[],
        signers: (typeof deployer.pkh)[] = [deployer.pkh], refDeeds: (typeof deed)[] = [deed],
    ): Promise<void> => {
        const badChunk = new Uint8Array(newChunk);
        mutate(badChunk);
        // rejection may come at BUILD (buildooor evals) or at SUBMIT (the
        // node's phase-2 validation is authoritative); either counts.
        let rejected = false, stage = "build";
        try {
            const txb = await provider.txBuilder();
            const tx = await txb.build({
                inputs: [
                    { utxo: leaf0, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit(ownerRects) } },
                    wall[0],
                ],
                readonlyRefInputs: refDeeds,
                requiredSigners: signers,
                collaterals: [collateralU],
                outputs: [{
                    address: masterpiece.address,
                    value: withAda(ADA(70), masterpiece.policyHex, [[LEAF_NFT_NAME, 1n]]),
                    datum: leafDatum(0, badChunk),
                }],
                changeAddress: deployer.address,
            });
            tx.signWith(deployer.prv);
            stage = "submit";
            await provider.submit(tx, `adv-${label}`);
        } catch { rejected = true; }
        assert(rejected, `"${label}" MUST be rejected but the ledger ACCEPTED it (${stage})`);
        console.log(`  rejected at ${stage}: ${label} ✓`);
    };

    // A — change a pixel OUTSIDE the owned (0,0)-(2,2) rect (no NFT for it)
    await attempt("paint pixel (3,3) — not owned", (c) => { c[3 * LINE_LENGTH + 3] = 0x11; }, [claimed]);
    // B — claim ownership of a rect you hold no deed for
    await attempt("edit claiming unowned rect (3,3)-(5,5)",
        (c) => { c[3 * LINE_LENGTH + 3] = 0x22; }, [{ x0: 3, y0: 3, x1: 5, y1: 5 }]);
    // C — edit your OWN rect but without signing as the deed's holder
    await attempt("edit owned rect (0,0)-(2,2) without the owner's signature",
        (c) => { c[0] = 0x33; }, [claimed], []);
    // D — reference no deed at all while changing owned pixels
    await attempt("edit with no deed referenced",
        (c) => { c[0] = 0x44; }, [claimed], [deployer.pkh], []);
    console.log("  all adversarial edits rejected ✓");
}

// ---------------------------------------------------------------------------
// 7. commit leaf 0 into the root
// ---------------------------------------------------------------------------
step("7. commit");
const newLeafCids = [newLeafCid, ...initialLeafCids.slice(1)];
const rootD1 = rootDatum(newLeafCids, bmpHeader);
{
    const mp = await provider.queryUtxos(masterpieceAddr);
    const root = findUtxoWithAsset(mp, masterpiece.policyHex, ROOT_REF_NFT_NAME);
    const leaf0 = mp.find((u) =>
        assetAmount(u, masterpiece.policyHex, LEAF_NFT_NAME) === 1n
        && utxoDatumHex(u) === datumHex(leafDatum(0, newChunk)));
    assert(root && leaf0, "root + edited leaf");
    const wall = (await provider.queryUtxos(deployerAddr)).filter((u) =>
        u.resolved.value.lovelaces >= ADA(100));

    // tx.refInputs is the SORTED set of [script ref, leaf0]; the redeemer
    // carries leaf0's position in that set
    const leafRefIdx = sortedRefIndex([refM.utxoRef, leaf0.utxoRef], leaf0.utxoRef);

    await sendTx({
        inputs: [
            { utxo: root, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit([leafRefIdx]) } },
            wall[0],
        ],
        readonlyRefInputs: [leaf0],
        collaterals: [collateralU],
        outputs: [{
            address: masterpiece.address,
            value: withAda(ADA(30), masterpiece.policyHex, [[ROOT_REF_NFT_NAME, 1n]]),
            datum: rootD1.data,
        }],
        changeAddress: deployer.address,
    }, deployer, "commit", masterpieceAddr);

    const rootAfter = findUtxoWithAsset(await provider.queryUtxos(masterpieceAddr), masterpiece.policyHex, ROOT_REF_NFT_NAME);
    assert(rootAfter, "root after commit");
    assert.equal(utxoDatumHex(rootAfter), datumHex(rootD1.data), "root datum updated");
    console.log("  committed. new image uri:", new TextDecoder().decode(rootD1.uri));
}

console.log("\nALL STEPS PASSED ✓");
