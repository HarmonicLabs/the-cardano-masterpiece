// Verify the recompiled stewardship contract passes the exact-claim (k=0)
// scenario that failed on the deployed script (PEBBLE_BUGS.md BUG 18).
// Takes the captured failing ScriptContext, patches every occurrence of the
// old policy hash to the freshly-applied script's hash, and evaluates.
//
//   CTX=<path to hex file> OLDPOLICY=<hex28> npx tsx probe-claim-fixed.ts
import { parseUPLC, Application, UPLCConst, dataFromCbor, Address, TxOutRef } from "@harmoniclabs/buildooor";
import { Machine } from "@harmoniclabs/plutus-machine";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stewardshipContract } from "./contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

// genesisUtxo only matters for `mint init`, not for the claim path: any ref works
const dummyGenesis = new TxOutRef({ id: "00".repeat(32), index: 0 });
const own = stewardshipContract(Address.fromString(config.protocolStewardAddress), dummyGenesis);
console.log("recompiled stewardship policy:", own.policyHex);

const oldPolicy = process.env.OLDPOLICY ?? config.stewardshipPolicy;
const ctxHex = readFileSync(process.env.CTX!, "utf8").trim()
    .replaceAll(oldPolicy, own.policyHex);

const prog = parseUPLC(own.script.bytes, "flat");
const applied = new Application(prog.body, UPLCConst.data(dataFromCbor(ctxHex)));
const res = Machine.evalSimple(applied);
console.log("result:", res?.constructor?.name ?? typeof res,
    JSON.stringify(res, (_k, v) => typeof v === "bigint" ? v.toString() : v)?.slice(0, 300));
