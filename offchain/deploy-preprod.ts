// ===========================================================================
//  CLEAN production deploy of the whole protocol to PREPROD.
//
//    npx tsx deploy-preprod.ts
//
//  Init-only — NO test claim/price-change/edit/commit. Produces a pristine
//  canvas (genesis all-0xFF image, price = LOVELACE_PER_PIXEL) owned by the
//  protocol owner, then rewrites website/config.json with the fresh addresses.
//
//  Steps (one tx each, threaded by change ref so the utxo flow is
//  deterministic):
//    0. split one pure-ada utxo into labelled funding utxos
//    1. deploy ownership + masterpiece reference scripts (parked at Lock)
//    2. ownership init   (FREE marker + PRICE NFT + whole-canvas free node +
//                         price-config node @ LOVELACE_PER_PIXEL)
//    3. masterpiece init (N_LEAFS leaf markers -> nursery + CIP-68 root)
//    4. deploy the marketplace reference script (parked at Lock)
//    5. write website/config.json
//
//  Afterwards run `npx tsx hatch-all.ts` to hatch all leaves.
//
//  Protocol owner: PROTOCOL_OWNER env, else website/config.json's
//  protocolOwnerAddress. The deployer wallet (keys/preprod.skey) funds + signs.
// ===========================================================================
import { Address, Value, Hash28, UTxO, dataToCbor, type Data, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadPreprodWallet } from "./provider.ts";
import { sortedRefIndex, findUtxoWithAsset, assetAmount, type Wallet } from "./lib.ts";
import {
    ownershipContract, masterpieceContract, marketplaceContract, lockContract, lockedDatum, buildBmpHeader,
    rootDatum, nurseryDatum, initialChunk, freeDatum, lovelacePerPixelDatum,
    mpMintInit, oMintInit,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME,
    N_LEAFS, LOVELACE_PER_PIXEL,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";
import assert from "node:assert";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "..", "website", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

type TokenEntry = [name: Uint8Array, amount: bigint];
const tokens = (policyHex: string, entries: TokenEntry[]): Value =>
    entries.reduce((v, [name, amt]) =>
        Value.add(v, Value.singleAsset(new Hash28(policyHex), name, amt)), Value.zero);
const withAda = (lovelace: bigint, policyHex: string, entries: TokenEntry[]): Value =>
    Value.add(Value.lovelaces(lovelace), tokens(policyHex, entries));

const provider = getProvider("preprod");
const wallet: Wallet = loadPreprodWallet();
const owner = Address.fromString(process.env.PROTOCOL_OWNER ?? config.protocolOwnerAddress);
console.log("deployer      :", wallet.address.toString());
console.log("protocol owner:", owner.toString());
assert(owner.toString() === config.protocolOwnerAddress || process.env.PROTOCOL_OWNER,
    "owner mismatch — set PROTOCOL_OWNER to override");

async function sendTx(args: ITxBuildArgs, label: string): Promise<string> {
    const txb = await provider.txBuilder();
    const tx = await txb.build(args);
    tx.signWith(wallet.prv);
    const h = await provider.submit(tx, label);
    console.log(`  [${label}] ${h}`);
    await provider.awaitTx(wallet.address.toString(), h);
    return h;
}
const byRef = (utxos: UTxO[], txid: string, ix: number): UTxO | undefined =>
    utxos.find((u) => u.utxoRef.id.toString() === txid && Number(u.utxoRef.index) === ix);
const step = (s: string): void => console.log(`\n== ${s} ==`);

// ---------------------------------------------------------------------------
step("0. split funds into labelled utxos");
const pure = (await provider.queryUtxos(wallet.address))
    .filter((u) => {
        const j = u.resolved.value.toJson() as Record<string, unknown>;
        return Object.keys(j).length === 1 && u.resolved.value.lovelaces >= ADA(1000)
            && u.resolved.refScript === undefined;
    })
    .sort((a, b) => Number(a.resolved.value.lovelaces - b.resolved.value.lovelaces));
assert(pure.length > 0, "no pure-ada utxo >= 1000 ADA in the deployer wallet");
// [0]=collateral 10, [1]=ownership genesis 5, [2]=masterpiece genesis 5,
// [3]=ref-deploy funds 150, [4]=working funds 800
const splitTx = await sendTx({
    inputs: [pure[0]],
    outputs: [
        { address: wallet.address, value: Value.lovelaces(ADA(10)) },
        { address: wallet.address, value: Value.lovelaces(ADA(5)) },
        { address: wallet.address, value: Value.lovelaces(ADA(5)) },
        { address: wallet.address, value: Value.lovelaces(ADA(150)) },
        { address: wallet.address, value: Value.lovelaces(ADA(800)) },
    ],
    changeAddress: wallet.address,
}, "fund-split");
let utxos = await provider.queryUtxos(wallet.address);
const collateralU = byRef(utxos, splitTx, 0)!;
const genesisO = byRef(utxos, splitTx, 1)!;
const genesisM = byRef(utxos, splitTx, 2)!;
const fundRefs = byRef(utxos, splitTx, 3)!;
const fundWork = byRef(utxos, splitTx, 4)!;
assert(collateralU && genesisO && genesisM && fundRefs && fundWork, "5 funding utxos");

// contracts parameterized by the two genesis refs
const bmpHeader = buildBmpHeader();
const ownership = ownershipContract(owner, genesisO.utxoRef);
const masterpiece = masterpieceContract(ownership.hash.toBuffer(), genesisM.utxoRef, bmpHeader);
const market = marketplaceContract(ownership.hash.toBuffer());
const lock = lockContract();
console.log("  ownership policy  :", ownership.policyHex);
console.log("  masterpiece policy:", masterpiece.policyHex);
console.log("  marketplace policy:", market.policyHex);

// ---------------------------------------------------------------------------
step("1. deploy reference scripts (parked at Lock, permanently unspendable)");
const deployO = await sendTx({
    inputs: [fundRefs],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(35)), refScript: ownership.script, datum: lockedDatum() }],
    changeAddress: wallet.address,
}, "deploy-ref-ownership");
const deployM = await sendTx({
    inputs: [byRef(await provider.queryUtxos(wallet.address), deployO, 1)!],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(60)), refScript: masterpiece.script, datum: lockedDatum() }],
    changeAddress: wallet.address,
}, "deploy-ref-masterpiece");
const atLock = await provider.queryUtxos(lock.address.toString());
const refO = byRef(atLock, deployO, 0)!;
const refM = byRef(atLock, deployM, 0)!;
assert(refO && refM, "ownership + masterpiece ref scripts parked");

// ---------------------------------------------------------------------------
step("2. ownership init (FREE marker + PRICE NFT + price config)");
{
    const gIdx = sortedRefIndex([genesisO.utxoRef, fundWork.utxoRef], genesisO.utxoRef);
    await sendTx({
        inputs: [genesisO, fundWork],
        collaterals: [collateralU],
        mints: [{
            value: tokens(ownership.policyHex, [[FREE_TOKEN_NAME, 1n], [PRICE_NFT_NAME, 1n]]),
            script: { ref: refO, redeemer: oMintInit(gIdx) },
        }],
        outputs: [
            { address: ownership.address, value: withAda(ADA(3), ownership.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum({ x0: 0, y0: 0, x1: 1008, y1: 1008 }) },
            { address: ownership.address, value: withAda(ADA(3), ownership.policyHex, [[PRICE_NFT_NAME, 1n]]), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: wallet.address,
    }, "ownership-init");
    const free = (await provider.queryUtxos(ownership.address))
        .filter((u) => assetAmount(u, ownership.policyHex, FREE_TOKEN_NAME) === 1n);
    assert.equal(free.length, 1, "one whole-canvas free node");
    console.log(`  free node + price config @ ${Number(LOVELACE_PER_PIXEL) / 1e6} ADA/px ✓`);
}

// ---------------------------------------------------------------------------
step("3. masterpiece init (nursery + CIP-68 root)");
const initCid = cidV1Raw(initialChunk());
const rootD0 = rootDatum(Array.from({ length: N_LEAFS }, () => initCid), bmpHeader);
{
    const oi = await provider.queryUtxos(wallet.address);
    // working change from the ownership-init tx (output index 2 = change)
    const workUtxo = oi.filter((u) => {
        const j = u.resolved.value.toJson() as Record<string, unknown>;
        return Object.keys(j).length === 1 && u.resolved.value.lovelaces >= ADA(100)
            && u.utxoRef.toString() !== collateralU.utxoRef.toString();
    }).sort((a, b) => Number(a.resolved.value.lovelaces - b.resolved.value.lovelaces))[0];
    assert(workUtxo, "working funds for masterpiece init");
    const ins = [genesisM, workUtxo];
    const gIdx = sortedRefIndex(ins.map((u) => u.utxoRef), genesisM.utxoRef);
    await sendTx({
        inputs: ins,
        collaterals: [collateralU],
        mints: [{
            value: tokens(masterpiece.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)], [ROOT_REF_NFT_NAME, 1n], [ROOT_USER_NFT_NAME, 1n]]),
            script: { ref: refM, redeemer: mpMintInit(gIdx) },
        }],
        outputs: [
            { address: masterpiece.address, value: withAda(ADA(15), masterpiece.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]]), datum: nurseryDatum(0) },
            { address: masterpiece.address, value: withAda(ADA(30), masterpiece.policyHex, [[ROOT_REF_NFT_NAME, 1n]]), datum: rootD0.data },
            { address: owner, value: withAda(ADA(2), masterpiece.policyHex, [[ROOT_USER_NFT_NAME, 1n]]) }, // (222) collection token -> owner
        ],
        changeAddress: wallet.address,
    }, "masterpiece-init");
    const mp = await provider.queryUtxos(masterpiece.address);
    assert(findUtxoWithAsset(mp, masterpiece.policyHex, ROOT_REF_NFT_NAME), "root (100) locked");
    console.log("  initial image uri:", new TextDecoder().decode(rootD0.uri));
}

// ---------------------------------------------------------------------------
step("4. deploy marketplace reference script (parked at Lock)");
const kFund = (await provider.queryUtxos(wallet.address))
    .filter((u) => {
        const j = u.resolved.value.toJson() as Record<string, unknown>;
        return Object.keys(j).length === 1 && u.resolved.value.lovelaces >= ADA(50)
            && u.resolved.refScript === undefined
            && u.utxoRef.toString() !== collateralU.utxoRef.toString();
    })
    .sort((a, b) => Number(a.resolved.value.lovelaces - b.resolved.value.lovelaces))[0];
assert(kFund, "funds for marketplace ref deploy");
const deployK = await sendTx({
    inputs: [kFund],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(25)), refScript: market.script, datum: lockedDatum() }],
    changeAddress: wallet.address,
}, "deploy-ref-marketplace");

// ---------------------------------------------------------------------------
step("5. write website/config.json");
const next = {
    ...config,
    network: "preprod",
    masterpiecePolicy: masterpiece.policyHex,
    masterpieceAddress: masterpiece.address.toString(),
    ownershipPolicy: ownership.policyHex,
    ownershipAddress: ownership.address.toString(),
    protocolOwnerAddress: owner.toString(),
    marketplacePolicy: market.policyHex,
    marketplaceAddress: market.address.toString(),
    ownershipRefScript: { txHash: deployO, index: 0 },
    masterpieceRefScript: { txHash: deployM, index: 0 },
    marketplaceRefScript: { txHash: deployK, index: 0 },
};
writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
console.log("  wrote", configPath);
console.log("\nDEPLOY COMPLETE ✓  — now run:  npx tsx hatch-all.ts");
