// ===========================================================================
//  Deploy the marketplace as a reference script on PREPROD.
//  Parameterized by the CURRENTLY DEPLOYED ownership policy (website config).
// ===========================================================================
import { Value } from "@harmoniclabs/buildooor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadPreprodWallet } from "./provider.ts";
import { marketplaceContract, lockContract, lockedDatum } from "./contracts.ts";
import { hexToBytes } from "./lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

const provider = getProvider("preprod");
const wallet = loadPreprodWallet();
const market = marketplaceContract(hexToBytes(config.ownershipPolicy));
console.log("ownership policy   :", config.ownershipPolicy);
console.log("marketplace policy :", market.policyHex);
console.log("marketplace address:", market.address.toString());

const utxos = await provider.queryUtxos(wallet.address);
const protectedRefs = [
    `${config.ownershipRefScript.txHash}#${config.ownershipRefScript.index}`,
    `${config.masterpieceRefScript.txHash}#${config.masterpieceRefScript.index}`,
];
const pure = utxos.filter((u) => {
    const j = u.resolved.value.toJson() as Record<string, unknown>;
    return Object.keys(j).length === 1
        && u.resolved.value.lovelaces >= 50_000_000n
        && u.resolved.refScript === undefined
        && !protectedRefs.includes(u.utxoRef.toString());
}).sort((a, b) => Number(b.resolved.value.lovelaces - a.resolved.value.lovelaces));
if (pure.length === 0) throw new Error("no usable pure-ada utxo in the deployer wallet");

const txb = await provider.txBuilder();
const lock = lockContract();
console.log("parking at Lock address (PERMANENT):", lock.address.toString());
const tx = await txb.build({
    inputs: [pure[0]],
    outputs: [{
        address: lock.address,
        value: Value.lovelaces(25_000_000n),
        refScript: market.script,
        datum: lockedDatum(),
    }],
    changeAddress: wallet.address,
});
tx.signWith(wallet.prv);
const hash = await provider.submit(tx, "deploy-ref-marketplace");
console.log("submitted:", hash);
await provider.awaitTx(wallet.address, hash);
console.log(`\nmarketplace ref: ${hash}#0`);
console.log("update website/config.json accordingly");
