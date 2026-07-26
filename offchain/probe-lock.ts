// ===========================================================================
//  Lock contract probe — every spend attempt must FAIL, whatever the datum
//  or redeemer. Offline: fabricated utxos, buildooor build-time eval.
// ===========================================================================
import {
    Address, Credential, PrivateKey, Value, TxBuilder, TxOut, TxOutRef, UTxO,
    DataConstr, DataI, defaultPreprodGenesisInfos, type ITxBuildArgs,
} from "@harmoniclabs/buildooor";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lockContract, lockedDatum, stewardshipContract } from "./contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

const key = (f: number): PrivateKey => new PrivateKey(new Uint8Array(32).fill(f));
const attacker = Address.testnet(Credential.keyHash(key(8).derivePublicKey().hash));
const lock = lockContract();
console.log("lock script:", lock.script.bytes.length, "bytes | address:", lock.address.toString());

const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;
let refN = 0;
const u = (address: Address, value: Value, datum?: DataConstr, refScript?: import("@harmoniclabs/buildooor").Script): UTxO =>
    new UTxO({ utxoRef: new TxOutRef({ id: (++refN).toString(16).padStart(64, "0"), index: 0 }), resolved: new TxOut({ address, value, datum, refScript }) });

// a parked ref-script utxo, exactly as the deployments will look
const own = stewardshipContract(attacker, new TxOutRef({ id: "00".repeat(32), index: 0 }));
const parkedRef = u(lock.address, Value.lovelaces(ADA(40)), lockedDatum(), own.script);
const lockedPlain = u(lock.address, Value.lovelaces(ADA(5)), lockedDatum());
const lockedGarbage = u(lock.address, Value.lovelaces(ADA(5)), new DataConstr(7, [new DataI(1)]));
const lockedNoDatum = u(lock.address, Value.lovelaces(ADA(5)));
const funds = u(attacker, Value.lovelaces(ADA(500)));
const coll = u(attacker, Value.lovelaces(ADA(10)));

const api = new BlockfrostPluts({ customBackend: (process.env.BLOCKFROST_URL ?? "https://blockfrost-preprod.onchainapps.io"), network: "preprod" });
const txb = new TxBuilder(await api.getProtocolParameters(), defaultPreprodGenesisInfos);

async function expectFail(name: string, args: ITxBuildArgs): Promise<void> {
    try { await txb.build(args); }
    catch { console.log(`  ${name} (unspendable, as required) ✓`); return; }
    throw new Error(`${name}: the Lock validator ACCEPTED a spend!`);
}

for (const [name, utxo] of [
    ["parked ref-script utxo (Locked datum)", parkedRef],
    ["plain Locked utxo", lockedPlain],
    ["garbage-datum utxo at lock address", lockedGarbage],
    ["datum-less utxo at lock address", lockedNoDatum],
] as const) {
    for (const rc of [0n, 1n]) {
        await expectFail(`${name}, redeemer Constr ${rc}`, {
            inputs: [
                { utxo, inputScript: { script: lock.script, datum: "inline", redeemer: new DataConstr(rc, []) } },
                funds,
            ],
            collaterals: [coll],
            changeAddress: attacker,
        });
    }
}
console.log("\nLOCK PROBE PASSED ✓ (8 spend attempts, all rejected)");
