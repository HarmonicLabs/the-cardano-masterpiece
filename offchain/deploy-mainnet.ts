// ===========================================================================
//  CLEAN production deploy of the whole protocol to MAINNET.
//
//    npx tsx deploy-mainnet.ts
//
//  ⚠️  REAL FUNDS. This mints the genesis state on Cardano mainnet and locks
//  ~120 ADA FOREVER in the three reference scripts (35 + 60 + 25). Run it only
//  when you have: a funded keys/mainnet.skey (+ keys/mainnet.addr) holding
//  ~1000 ADA in one pure-ada utxo (of which only ~120 stays locked, the rest
//  returns as change), and you have double-checked the steward address below.
//
//  Init-only — NO test claim/price-change/edit/commit. Produces a pristine
//  canvas (genesis all-0xFF image, price = LOVELACE_PER_PIXEL = 2.5 ADA/px,
//  contract floor 0.5 ADA/px) owned by the protocol steward, then rewrites
//  website/config.json with the fresh mainnet addresses + network:"mainnet".
//
//  Steps (one tx each, threaded by change ref):
//    0. split one pure-ada utxo into labelled funding utxos
//    1. deploy stewardship + masterpiece reference scripts (parked at Lock)
//    2. stewardship init   (FREE marker + PRICE NFT + whole-canvas free node +
//                         price-config node @ LOVELACE_PER_PIXEL)
//    3. masterpiece init (N_LEAFS leaf markers -> nursery + CIP-68 root)
//    4. deploy the marketplace reference script (parked at Lock)
//    5. write website/config.json  (network: "mainnet")
//
//  Afterwards run `npx tsx hatch-all.ts` (BACKEND=mainnet) to hatch all leaves.
//
//  Protocol steward: PROTOCOL_STEWARD env, else MAINNET_STEWARD below.
//  Deployer wallet: keys/mainnet.skey (funds + signs).
// ===========================================================================
import { Address, Value, Hash28, UTxO, dataToCbor, type Data, type ITxBuildArgs } from "@harmoniclabs/buildooor";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadMainnetWallet } from "./provider.ts";
import { sortedRefIndex, findUtxoWithAsset, assetAmount, type Wallet } from "./lib.ts";
import {
    stewardshipContract, masterpieceContract, marketplaceContract, lockContract, lockedDatum, buildBmpHeader,
    rootDatum, nurseryDatum, initialChunk, freeDatum, lovelacePerPixelDatum,
    mpMintInit, oMintInit,
    FREE_TOKEN_NAME, PRICE_NFT_NAME, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME,
    N_LEAFS, LOVELACE_PER_PIXEL,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";
import assert from "node:assert";

// The mainnet protocol steward (receives claim payments, sets price, holds the
// (222) root NFT). Override with PROTOCOL_STEWARD; must be a mainnet (addr1) address.
const MAINNET_STEWARD = "addr1qy7aq92yfxew05t59870yuj4z2lzl078v7zu96m22uvfgyrcuykx0e2rn3lqhvm0ngx0hhwyydf3cyw2n987t3w7m6qqaz89xl";

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

const provider = getProvider("mainnet");
const wallet: Wallet = loadMainnetWallet();
const steward = Address.fromString(process.env.PROTOCOL_STEWARD ?? MAINNET_STEWARD);
console.log("network       : MAINNET");
console.log("deployer      :", wallet.address.toString());
console.log("protocol steward:", steward.toString());
assert(steward.toString().startsWith("addr1"), "protocol steward must be a MAINNET (addr1) address");
assert(!wallet.address.toString().startsWith("addr_test"), "deployer must be a MAINNET wallet");

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
// consume ALL pure-ada utxos (consolidate + split in one tx) so this works
// whether the deployer holds one big utxo or several small ones (e.g. after a
// prior failed run left the split utxos behind).
const pure = (await provider.queryUtxos(wallet.address))
    .filter((u) => {
        const j = u.resolved.value.toJson() as Record<string, unknown>;
        return Object.keys(j).length === 1 && u.resolved.refScript === undefined;
    });
const pureTotal = pure.reduce((s, u) => s + u.resolved.value.lovelaces, 0n);
assert(pureTotal >= ADA(197), `need >= 197 ADA in pure utxos, have ${pureTotal / 1_000_000n}`);
// INIT-ONLY lean split for a ~200 ADA budget (leaves hatched separately later).
// Cost: 35+60+25 ref scripts + 6+47 init outputs + fees ≈ 178 ADA.
// [0]=collateral 5, [1]=stewardship genesis 3, [2]=masterpiece genesis 3,
// [3]=ref-deploy funds 100 (35+60 locked here), [4]=working funds 86 (inits + mkt ref)
const splitTx = await sendTx({
    inputs: pure,
    outputs: [
        { address: wallet.address, value: Value.lovelaces(ADA(5)) },
        { address: wallet.address, value: Value.lovelaces(ADA(3)) },
        { address: wallet.address, value: Value.lovelaces(ADA(3)) },
        { address: wallet.address, value: Value.lovelaces(ADA(100)) },
        { address: wallet.address, value: Value.lovelaces(ADA(86)) },
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
const stewardship = stewardshipContract(steward, genesisO.utxoRef);
const masterpiece = masterpieceContract(stewardship.hash.toBuffer(), genesisM.utxoRef, bmpHeader);
const market = marketplaceContract(stewardship.hash.toBuffer());
const lock = lockContract();
console.log("  stewardship policy  :", stewardship.policyHex);
console.log("  masterpiece policy:", masterpiece.policyHex);
console.log("  marketplace policy:", market.policyHex);

// ---------------------------------------------------------------------------
step("1. deploy reference scripts (parked at Lock, permanently unspendable)");
const deployO = await sendTx({
    inputs: [fundRefs],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(35)), refScript: stewardship.script, datum: lockedDatum() }],
    changeAddress: wallet.address,
}, "deploy-ref-stewardship");
const deployM = await sendTx({
    inputs: [byRef(await provider.queryUtxos(wallet.address), deployO, 1)!],
    outputs: [{ address: lock.address, value: Value.lovelaces(ADA(60)), refScript: masterpiece.script, datum: lockedDatum() }],
    changeAddress: wallet.address,
}, "deploy-ref-masterpiece");
const atLock = await provider.queryUtxos(lock.address.toString());
const refO = byRef(atLock, deployO, 0)!;
const refM = byRef(atLock, deployM, 0)!;
assert(refO && refM, "stewardship + masterpiece ref scripts parked");

// ---------------------------------------------------------------------------
step("2. stewardship init (FREE marker + PRICE NFT + price config)");
{
    const gIdx = sortedRefIndex([genesisO.utxoRef, fundWork.utxoRef], genesisO.utxoRef);
    await sendTx({
        inputs: [genesisO, fundWork],
        collaterals: [collateralU],
        mints: [{
            value: tokens(stewardship.policyHex, [[FREE_TOKEN_NAME, 1n], [PRICE_NFT_NAME, 1n]]),
            script: { ref: refO, redeemer: oMintInit(gIdx) },
        }],
        outputs: [
            { address: stewardship.address, value: withAda(ADA(3), stewardship.policyHex, [[FREE_TOKEN_NAME, 1n]]), datum: freeDatum({ x0: 0, y0: 0, x1: 1008, y1: 1008 }) },
            { address: stewardship.address, value: withAda(ADA(3), stewardship.policyHex, [[PRICE_NFT_NAME, 1n]]), datum: lovelacePerPixelDatum(LOVELACE_PER_PIXEL) },
        ],
        changeAddress: wallet.address,
    }, "stewardship-init");
    const free = (await provider.queryUtxos(stewardship.address))
        .filter((u) => assetAmount(u, stewardship.policyHex, FREE_TOKEN_NAME) === 1n);
    assert.equal(free.length, 1, "one whole-canvas free node");
    console.log(`  free node + price config @ ${Number(LOVELACE_PER_PIXEL) / 1e6} ADA/px ✓`);
}

// ---------------------------------------------------------------------------
step("3. masterpiece init (nursery + CIP-68 root)");
const initCid = cidV1Raw(initialChunk());
const rootD0 = rootDatum(Array.from({ length: N_LEAFS }, () => initCid), bmpHeader);
{
    const oi = await provider.queryUtxos(wallet.address);
    // working change from the stewardship-init tx (output index 2 = change)
    const workUtxo = oi.filter((u) => {
        const j = u.resolved.value.toJson() as Record<string, unknown>;
        return Object.keys(j).length === 1 && u.resolved.value.lovelaces >= ADA(60)
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
            { address: steward, value: withAda(ADA(2), masterpiece.policyHex, [[ROOT_USER_NFT_NAME, 1n]]) }, // (222) collection token -> steward
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
        return Object.keys(j).length === 1 && u.resolved.value.lovelaces >= ADA(30)
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
step("5. write website/config.json (network: mainnet)");
const next = {
    ...config,
    network: "mainnet",
    masterpiecePolicy: masterpiece.policyHex,
    masterpieceAddress: masterpiece.address.toString(),
    stewardshipPolicy: stewardship.policyHex,
    stewardshipAddress: stewardship.address.toString(),
    protocolStewardAddress: steward.toString(),
    marketplacePolicy: market.policyHex,
    marketplaceAddress: market.address.toString(),
    stewardshipRefScript: { txHash: deployO, index: 0 },
    masterpieceRefScript: { txHash: deployM, index: 0 },
    marketplaceRefScript: { txHash: deployK, index: 0 },
};
writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
console.log("  wrote", configPath);
console.log("\nMAINNET DEPLOY COMPLETE ✓  — now run:  BACKEND=mainnet npx tsx hatch-all.ts");
