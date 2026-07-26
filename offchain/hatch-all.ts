// ===========================================================================
//  Hatch ALL remaining masterpiece leaves on the DEPLOYED preprod contract.
//
//    npx tsx hatch-all.ts
//
//  The nursery starts holding every leaf marker; each `hatch` peels ONE marker
//  into a fresh leaf utxo (14 KB chunk of 0xFF) + a smaller continuing nursery.
//  This drains it to zero, one leaf per tx, mempool-chained: every hatch spends
//  the PREDICTED nursery + change outputs of the previous one (awaiting
//  confirmation only every 10 txs). It resumes cleanly if some leaves already
//  exist — it reads how far the nursery has advanced and continues from there.
//
//  Config (deployed policy/address + parked reference script) is read from
//  website/config.json; the deployer wallet is offchain/keys/preprod.skey.
//
//  NOTE: each leaf locks ~70 ada of min-utxo (a 14 KB inline datum), so hatching
//  all 73 leaves parks ~5100 ada forever — the true cost of a 1 MB on-chain image.
// ===========================================================================
import {
    Address, Value, Hash28, UTxO, TxOut, TxOutRef, dataToCbor, type Data,
} from "@harmoniclabs/buildooor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadMainnetWallet } from "./provider.ts";
import {
    lockContract, leafDatum, nurseryDatum, initialChunk, mpHatch,
    N_LEAFS, LEAF_NFT_NAME,
} from "./contracts.ts";
import { assetAmount } from "./lib.ts";

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
// leaf/nursery deposits are the EXACT min-utxo (computed per output below), so
// no more ada than the ledger requires is ever parked at the script.

type TokenEntry = [name: Uint8Array, amount: bigint];
const tokens = (policyHex: string, entries: TokenEntry[]): Value =>
    entries.reduce((v, [name, amt]) =>
        Value.add(v, Value.singleAsset(new Hash28(policyHex), name, amt)), Value.zero);
const withAda = (lovelace: bigint, policyHex: string, entries: TokenEntry[]): Value =>
    Value.add(Value.lovelaces(lovelace), tokens(policyHex, entries));

const datumHex = (d: Data): string => dataToCbor(d).toString();
const utxoDatumHex = (u: UTxO): string | undefined =>
    u.resolved.datum ? dataToCbor(u.resolved.datum as Data).toString() : undefined;
const isPureAda = (u: UTxO): boolean =>
    Object.keys(u.resolved.value.toJson() as Record<string, unknown>).length === 1
    && u.resolved.refScript === undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));
const policy: string = config.masterpiecePolicy;
const mpAddr = Address.fromString(config.masterpieceAddress);
const refRef = `${config.masterpieceRefScript.txHash}#${config.masterpieceRefScript.index}`;

const provider = getProvider("mainnet");
const wallet = loadMainnetWallet();
console.log("deployer   :", wallet.address.toString());
console.log("masterpiece:", config.masterpieceAddress);

// ---- locate the parked masterpiece reference script -----------------------
const refM = (await provider.queryUtxos(lockContract().address))
    .find((u) => u.utxoRef.toString() === refRef);
if (!refM) throw new Error(`masterpiece ref script ${refRef} not found at the lock address`);

// ---- locate the nursery + how far it has advanced -------------------------
const mp = await provider.queryUtxos(mpAddr);
const leavesNow = mp.filter((u) => assetAmount(u, policy, LEAF_NFT_NAME) === 1n
    && utxoDatumHex(u) !== datumHex(nurseryDatum(N_LEAFS - 1)));   // exclude a 1-marker final nursery
// the nursery is the marker-bearing utxo whose datum is Nursery(next), where
// next = N_LEAFS - (markers it still holds)
let nursery = mp.find((u) => {
    const amt = assetAmount(u, policy, LEAF_NFT_NAME);
    return amt >= 1n && utxoDatumHex(u) === datumHex(nurseryDatum(N_LEAFS - Number(amt)));
});

if (!nursery) {
    if (leavesNow.length === N_LEAFS) {
        console.log(`\nall ${N_LEAFS} leaves already hatched — nothing to do ✓`);
        process.exit(0);
    }
    throw new Error(`no nursery found and only ${leavesNow.length}/${N_LEAFS} leaves exist`);
}
const nextLeaf = N_LEAFS - Number(assetAmount(nursery, policy, LEAF_NFT_NAME));
const todo = N_LEAFS - nextLeaf;
console.log(`nursery at leaf ${nextLeaf}; hatching ${todo} more (leaves ${nextLeaf}..${N_LEAFS - 1})`);

// ---- exact min-utxo per output (Babbage rule; converges in 1-2 passes) -----
const txb = await provider.txBuilder();
const minAdaFor = (value: (lov: bigint) => Value, datum: Data): bigint => {
    let lov = 5_000_000n;                          // placeholder in the target magnitude
    for (let i = 0; i < 8; i++) {
        const m = txb.getMinimumOutputLovelaces(new TxOut({ address: mpAddr, value: value(lov), datum }));
        if (m === lov) break;
        lov = m;
    }
    return lov;
};
const leafValue = (lov: bigint) => withAda(lov, policy, [[LEAF_NFT_NAME, 1n]]);
const leafMin = minAdaFor(leafValue, leafDatum(N_LEAFS - 1, initialChunk()));  // worst-case idx size
console.log(`leaf min-utxo: ${leafMin} lovelace (~${(Number(leafMin) / 1e6).toFixed(2)} ada each)`);

// ---- funding: consolidate the wallet's pure-ada utxos into the chain ------
const pure = (await provider.queryUtxos(wallet.address))
    .filter((u) => isPureAda(u) && u.utxoRef.toString() !== refRef)
    .sort((a, b) => Number(b.resolved.value.lovelaces - a.resolved.value.lovelaces));
const have = pure.reduce((s, u) => s + u.resolved.value.lovelaces, 0n);
const need = BigInt(todo) * leafMin + ADA(30);    // leaf deposits + fee headroom
if (pure.length === 0) throw new Error("wallet has no pure-ada utxo to fund hatching");
if (have < need)
    throw new Error(`insufficient funds: ~${need / 1_000_000n} ada needed, ${have / 1_000_000n} ada spendable`);

// ---- drain the nursery one leaf per tx (mempool-chained) ------------------
let fundingInputs: UTxO[] = pure;                 // first tx pulls in all pure-ada utxos
let prevHash: string | undefined;                 // parent tx, for retry-on-propagation-lag
for (let leaf = nextLeaf; leaf < N_LEAFS; leaf++) {
    const last = leaf === N_LEAFS - 1;
    const remaining = N_LEAFS - leaf;             // markers the nursery holds right now
    // deposit EXACTLY the ledger minimum into each script output
    const leafDatm = leafDatum(leaf, initialChunk());
    const leafAda = minAdaFor(leafValue, leafDatm);
    const nurseryValue = (lov: bigint) => withAda(lov, policy, [[LEAF_NFT_NAME, BigInt(remaining - 1)]]);
    const nurseryDatm = nurseryDatum(leaf + 1);
    const nurseryAda = minAdaFor(nurseryValue, nurseryDatm);
    const tx = await txb.build({
        inputs: [
            { utxo: nursery!, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpHatch() } },
            ...fundingInputs,
        ],
        outputs: [
            {   // the hatched leaf FIRST (validator expects marker-outs order [leaf, nursery])
                address: mpAddr,
                value: leafValue(leafAda),
                datum: leafDatm,
            },
            ...(last ? [] : [{   // continuing nursery (none on the final hatch)
                address: mpAddr,
                value: nurseryValue(nurseryAda),
                datum: nurseryDatm,
            }]),
        ],
        changeAddress: wallet.address,
    });
    tx.signWith(wallet.prv);
    const hash = tx.hash.toString();
    try {
        await provider.submit(tx, `hatch-${leaf}`);
    } catch (e) {
        // CHAINED submit: blockfrost occasionally hasn't propagated the PARENT
        // to the node's mempool when this child arrives ("all inputs are spent /
        // transaction has probably already been included"). Confirm the parent
        // on-chain, then retry this child once. Chaining stays fast; this only
        // fires on the odd propagation hiccup.
        const msg = String((e as Error)?.message ?? e);
        if (!prevHash || !/already been included|inputs are spent|already exists|ValueNotConserved/i.test(msg)) throw e;
        await provider.awaitTx(mpAddr, prevHash);
        await provider.submit(tx, `hatch-${leaf}`);
    }
    prevHash = hash;

    const outs = tx.body.outputs;
    if (!last) nursery = new UTxO({
        utxoRef: new TxOutRef({ id: hash, index: 1 }), resolved: outs[1] });
    // chain the change (always the last output) to fund the next hatch
    fundingInputs = [new UTxO({
        utxoRef: new TxOutRef({ id: hash, index: outs.length - 1 }),
        resolved: outs[outs.length - 1] })];

    // blockfrost.io's shared/load-balanced submit does NOT sustain a deep
    // mempool chain: after ~8-14 back-to-back submits a backend node with an
    // inconsistent view rejects with "all inputs are spent" (and confirming the
    // parent + retrying doesn't clear it). So CONFIRM each tx on-chain before
    // chaining the next — reliable on mainnet; the retry above covers residual
    // hiccups. (Devnet/a single node can chain freely; blockfrost cannot.)
    await provider.awaitTx(mpAddr, hash);
    if ((leaf - nextLeaf) % 10 === 9 || last) console.log(`  hatched through leaf ${leaf} ✓`);
}

// ---- verify the nursery is fully drained ----------------------------------
const after = await provider.queryUtxos(mpAddr);
const leaves = after.filter((u) => assetAmount(u, policy, LEAF_NFT_NAME) === 1n
    && utxoDatumHex(u) !== datumHex(nurseryDatum(N_LEAFS - 1)));
if (after.some((u) => assetAmount(u, policy, LEAF_NFT_NAME) > 1n))
    throw new Error("nursery still holds markers — hatching incomplete");
console.log(`\nALL ${N_LEAFS} leaves hatched, nursery drained ✓ (${leaves.length} leaf utxos on-chain)`);
