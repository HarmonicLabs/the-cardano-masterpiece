// ===========================================================================
//  Sweep the mainnet deployer wallet's leftover ADA to the protocol steward.
//    BLOCKFROST_PROJECT_ID=mainnet... BACKEND=mainnet npx tsx sweep-to-steward.ts
//  Sends EVERYTHING (inputs - fee) to the steward via changeAddress.
// ===========================================================================
import { Address } from "@harmoniclabs/buildooor";
import { getProvider, loadMainnetWallet } from "./provider.ts";
import assert from "node:assert";

const STEWARD = "addr1qy7aq92yfxew05t59870yuj4z2lzl078v7zu96m22uvfgyrcuykx0e2rn3lqhvm0ngx0hhwyydf3cyw2n987t3w7m6qqaz89xl";

const provider = getProvider("mainnet");
const wallet = loadMainnetWallet();
const steward = Address.fromString(STEWARD);
assert(steward.toString().startsWith("addr1"), "steward must be a mainnet address");

const utxos = await provider.queryUtxos(wallet.address);
assert(utxos.length > 0, "nothing to sweep — deployer is empty");
const total = utxos.reduce((s, u) => s + u.resolved.value.lovelaces, 0n);
// refuse if any utxo carries tokens (would sweep them too — not expected here)
for (const u of utxos) {
    const j = u.resolved.value.toJson() as Record<string, unknown>;
    assert(Object.keys(j).length === 1, `utxo ${u.utxoRef.toString()} carries native tokens — aborting`);
}

console.log("deployer:", wallet.address.toString());
console.log("steward :", steward.toString());
console.log(`sweeping ${Number(total) / 1e6} ADA (${utxos.length} utxo${utxos.length === 1 ? "" : "s"}), everything minus fee → steward`);

const txb = await provider.txBuilder();
const tx = await txb.build({
    inputs: utxos,
    changeAddress: steward,   // entire balance minus fee lands at the steward
});
tx.signWith(wallet.prv);
const h = await provider.submit(tx, "sweep-to-steward");
console.log("  [sweep] submitted", h);
await provider.awaitTx(steward, h);
console.log("SWEEP COMPLETE ✓ — remaining ADA returned to the protocol owner");
