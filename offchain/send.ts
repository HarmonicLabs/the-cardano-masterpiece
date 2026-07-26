// ===========================================================================
//  Send ADA from the PREPROD deployer wallet (offchain/keys/preprod.skey).
//
//    npx tsx send.ts                      # 500 ada to the default recipient
//    npx tsx send.ts <address> [ada]      # custom recipient / amount
//
//  Never touches utxos that carry reference scripts (the deployments live
//  in this wallet) or utxos holding tokens.
// ===========================================================================
import { Address, Value } from "@harmoniclabs/buildooor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadPreprodWallet } from "./provider.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

const DEFAULT_RECIPIENT = "addr_test1qzq55vqf303tduqa0f6r4rmamt2lxw5c98yp5rcyekl6aupgrkxchwfa7uzxtc4sssn4hdp8pdhpe0gvnl3tec8yzjsq5enqa4";
const DEFAULT_ADA_AMOUNT = 500;

const recipient = process.argv[2] ?? DEFAULT_RECIPIENT;
const ada = BigInt(process.argv[3] ?? DEFAULT_ADA_AMOUNT);
const lovelace = ada * 1_000_000n;

const provider = getProvider("preprod");
const wallet = loadPreprodWallet();
console.log("from  :", wallet.address.toString());
console.log("to    :", recipient);
console.log("amount:", ada.toString(), "ada");

const protectedRefs = [
    config.stewardshipRefScript, config.masterpieceRefScript, config.marketplaceRefScript,
].map((r: { txHash: string; index: number }) => `${r.txHash}#${r.index}`);

const utxos = await provider.queryUtxos(wallet.address);
const pure = utxos.filter((u) => {
    const j = u.resolved.value.toJson() as Record<string, unknown>;
    return Object.keys(j).length === 1                    // ada only, no tokens
        && u.resolved.refScript === undefined             // never a deployment
        && !protectedRefs.includes(u.utxoRef.toString());
}).sort((a, b) => Number(b.resolved.value.lovelaces - a.resolved.value.lovelaces));

// pick the fewest large utxos covering amount + fee headroom
const inputs: typeof pure = [];
let total = 0n;
for (const u of pure) {
    inputs.push(u); total += u.resolved.value.lovelaces;
    if (total >= lovelace + 2_000_000n) break;
}
if (total < lovelace + 2_000_000n)
    throw new Error(`insufficient funds: have ${total / 1_000_000n} ada spendable, need ${ada + 2n}`);

const txb = await provider.txBuilder();
const tx = await txb.build({
    inputs,
    outputs: [{ address: Address.fromString(recipient), value: Value.lovelaces(lovelace) }],
    changeAddress: wallet.address,
});
tx.signWith(wallet.prv);
const hash = await provider.submit(tx, "send");
console.log("submitted:", hash);
await provider.awaitTx(wallet.address, hash);
console.log("confirmed ✓");
