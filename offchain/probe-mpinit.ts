// devnet probe: masterpiece init, LOCAL evaluation only (throws on failure),
// prints exUnits on success — the fast BUG-16-style budget check.
import { Value, Hash28 } from "@harmoniclabs/buildooor";
import { queryUtxos, ensureWallet, fundFromGenesis, awaitTxAtAddr, txBuilder, sortedRefIndex } from "./lib.ts";
import {
    ownershipContract, masterpieceContract, buildBmpHeader, rootDatum, nurseryDatum,
    initialChunk, mpMintInit, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME, N_LEAFS,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";

const w = ensureWallet(`probe-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: w.address, lovelace: 10_000_000n },
    { address: w.address, lovelace: 500_000_000n },
], "fund-mpinit");
awaitTxAtAddr(w.address, fundTx);
const utxos = queryUtxos(w.address);
const collateral = utxos.find(u => u.resolved.value.lovelaces === 10_000_000n)!;
const funds = utxos.find(u => u.resolved.value.lovelaces === 500_000_000n)!;

const bmpHeader = buildBmpHeader();
const ownership = ownershipContract(w.address, funds.utxoRef); // dummy, just for the hash
const mp = masterpieceContract(ownership.hash.toBuffer(), funds.utxoRef, bmpHeader);
const initCid = cidV1Raw(initialChunk());
const rootD = rootDatum(Array.from({ length: N_LEAFS }, () => initCid), bmpHeader);
const extra = utxos.find(u => u.resolved.value.lovelaces !== 10_000_000n && u !== funds) ?? collateral;
const gIdx = sortedRefIndex([funds.utxoRef, extra.utxoRef], funds.utxoRef);
console.log("  genesis input index in sorted inputs:", gIdx);
const toks = (entries: [Uint8Array, bigint][]) =>
    entries.reduce((v, [n, a]) => Value.add(v, Value.singleAsset(new Hash28(mp.policyHex), n, a)), Value.zero);

try {
    const tx = await txBuilder().build({
        inputs: [funds, extra],
        collaterals: [collateral],
        mints: [{
            value: toks([[LEAF_NFT_NAME, BigInt(N_LEAFS)], [ROOT_REF_NFT_NAME, 1n], [ROOT_USER_NFT_NAME, 1n]]),
            script: { inline: mp.script, redeemer: mpMintInit(gIdx) },
        }],
        outputs: [
            { address: mp.address, value: Value.add(Value.lovelaces(15_000_000n), toks([[LEAF_NFT_NAME, BigInt(N_LEAFS)]])), datum: nurseryDatum(0) },
            { address: mp.address, value: Value.add(Value.lovelaces(30_000_000n), toks([[ROOT_REF_NFT_NAME, 1n]])), datum: rootD.data },
            { address: w.address, value: Value.add(Value.lovelaces(2_000_000n), toks([[ROOT_USER_NFT_NAME, 1n]])) },
        ],
        changeAddress: w.address,
    });
    for (const r of tx.witnesses.redeemers ?? [])
        console.log("  exUnits:", (r as { execUnits?: { toJson?(): unknown } }).execUnits?.toJson?.());
    console.log("MP INIT local eval PASSED");
} catch (e) {
    const m = String((e as Error).message).match(/error message: [^\n]*/);
    console.log("MP INIT FAILED:", m ? m[0] : String((e as Error).message).slice(0, 200));
}
