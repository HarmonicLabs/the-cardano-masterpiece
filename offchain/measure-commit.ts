// ===========================================================================
//  Measure the commit cost curve on the LIVE devnet full-hatch state:
//  build (do NOT submit) commit txs referencing K leaves and report the
//  ex-units buildooor computes + the tx size, for growing K.
//
//    MASTERPIECE_POLICY=<hex> REF_M=<txhash#0> WALLET=<name> npx tsx measure-commit.ts
// ===========================================================================
import { Address, Credential, Hash28, TxOutRef, Value, dataToCbor, type Data } from "@harmoniclabs/buildooor";
import { loadWallet, queryUtxos, sortedRefIndex, findUtxoWithAsset, assetAmount, pureAdaUtxo, txBuilder } from "./lib.ts";
import { lockContract } from "./contracts.ts";
import {
    buildBmpHeader, rootDatum, mpCommit,
    ROOT_REF_NFT_NAME, LEAF_NFT_NAME, N_LEAFS,
} from "./contracts.ts";
import assert from "node:assert";

const policyHex = process.env.MASTERPIECE_POLICY!;
const [refTx, refIx] = process.env.REF_M!.split("#");
const wallet = loadWallet(process.env.WALLET!);
const mpAddr = Address.testnet(Credential.script(new Hash28(policyHex))).toString();

const mp = queryUtxos(mpAddr);
const root = findUtxoWithAsset(mp, policyHex, ROOT_REF_NFT_NAME)!;
assert(root, "root utxo");
const leaves = mp
    .filter((u) => assetAmount(u, policyHex, LEAF_NFT_NAME) === 1n && u.resolved.datum)
    .map((u) => {
        const d = u.resolved.datum as Data & { constr: bigint; fields: (Data & { int: bigint })[] };
        return { idx: Number(d.fields[0].int), utxo: u };
    })
    .sort((a, b) => a.idx - b.idx);
assert(leaves.length >= 1, "at least one hatched leaf");

// current root CID list (RootNft = Constr 0 [meta, version, extra(Constr 0 [cids, rawCid])])
const rd = root.resolved.datum as Data & { fields: { fields: { list: { bytes: Uint8Array }[] }[] }[] };
const cids = rd.fields[2].fields[0].list.map((b) => new Uint8Array(b.bytes));
assert(cids.length === N_LEAFS, "root cid list");
const rootD = rootDatum(cids, buildBmpHeader()); // no-op commit: same cids -> same datum

const refM = [...queryUtxos(lockContract().address), ...queryUtxos(wallet.address)].find((u) =>
    u.utxoRef.id.toString() === refTx && Number(u.utxoRef.index) === Number(refIx))!;
assert(refM?.resolved.refScript, "masterpiece ref script utxo");
const collateral = queryUtxos(wallet.address).find((u) => u.resolved.value.lovelaces === 10_000_000n)
    ?? pureAdaUtxo(queryUtxos(wallet.address), 8_000_000n)!;
const wall = pureAdaUtxo(queryUtxos(wallet.address).filter((u) => u !== collateral && u.resolved.refScript === undefined), 40_000_000n)!;

const txb = txBuilder();
{
    const K = 1; // single-leaf commit: the only shape the contract now has
    const refs = leaves.slice(0, K).map((l) => l.utxo);
    const allRefs = [refM.utxoRef, ...refs.map((u) => u.utxoRef)];
    const idx = sortedRefIndex(allRefs, refs[0].utxoRef);
    try {
        const tx = await txb.build({
            inputs: [
                { utxo: root, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit([idx]) } },
                wall,
            ],
            readonlyRefInputs: refs,
            collaterals: [collateral],
            outputs: [{
                address: Address.fromString(mpAddr),
                value: Value.add(Value.lovelaces(root.resolved.value.lovelaces),
                    Value.singleAsset(new Hash28(policyHex), ROOT_REF_NFT_NAME, 1n)),
                datum: rootD.data,
            }],
            changeAddress: wallet.address,
        });
        const r = (tx.witnesses.redeemers ?? [])[0];
        const ex = r ? r.execUnits.toJson() as { mem: string | number; cpu?: string | number; steps?: string | number } : undefined;
        const mem = Number(ex?.mem ?? 0), cpu = Number(ex?.cpu ?? ex?.steps ?? 0);
        console.log(`K=${String(K).padStart(3)}: tx ${tx.toCborBytes().length} B | mem ${(mem / 1e6).toFixed(2)}M/140M | cpu ${(cpu / 1e9).toFixed(2)}B/10B`);
    } catch (e) {
        console.log(`K=${String(K).padStart(3)}: FAILED — ${String((e as Error).message).split("\n")[0].slice(0, 120)}`);
    }
}
void dataToCbor;
