// Reproduce the exact-claim (k=0) failure OFF-CHAIN by evaluating the
// deployed stewardship script directly against the script context captured
// from the failing tx build (see PEBBLE_BUGS.md).
//
//   CTX=<path to hex file with the ScriptContext data cbor>
//
// Fetches the reference script from preprod (same bytes that fail on-chain).
import { parseUPLC, Application, UPLCConst, dataFromCbor, TxOutRef } from "@harmoniclabs/buildooor";
import { Machine } from "@harmoniclabs/plutus-machine";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

const ctxHex = readFileSync(process.env.CTX ?? "/dev/stdin", "utf8").trim();
const ctxData = dataFromCbor(ctxHex);

const api = new BlockfrostPluts({ customBackend: (process.env.BLOCKFROST_URL ?? "https://blockfrost-preprod.onchainapps.io"), network: "preprod" });
const [refU] = await api.resolveUtxos([
    new TxOutRef({ id: config.stewardshipRefScript.txHash, index: config.stewardshipRefScript.index }),
]);
const script = refU.resolved.refScript!;
console.log("deployed stewardship script:", script.hash.toString());

const prog = parseUPLC(script.bytes, "flat");
const applied = new Application(prog.body, UPLCConst.data(ctxData));
const res = Machine.evalSimple(applied);
console.log("result:", res?.constructor?.name, JSON.stringify(res, (_k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 400));
