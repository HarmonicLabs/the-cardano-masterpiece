// Evaluate the CURRENT masterpiece build's hatch path against a CAPTURED
// failing ScriptContext (CTX env = hex file). The hatch validator reads
// nothing from the params, so dummy params are fine — the context's own
// addresses/policies stay self-consistent.
import { Address, TxOutRef, dataFromCbor, parseUPLC, Application, UPLCConst, Credential, PrivateKey } from "@harmoniclabs/buildooor";
import { Machine } from "@harmoniclabs/plutus-machine";
import { readFileSync } from "node:fs";
import { masterpieceContract, buildBmpHeader } from "./contracts.ts";

const ctxHex = readFileSync(process.env.CTX!, "utf8").trim();
const dummyAddr = Address.testnet(Credential.keyHash(new PrivateKey(new Uint8Array(32).fill(1)).derivePublicKey().hash));
void dummyAddr;
const mp = masterpieceContract(new Uint8Array(28), new TxOutRef({ id: "00".repeat(32), index: 0 }), buildBmpHeader());
const prog = parseUPLC(mp.script.bytes, "flat");
const res = Machine.evalSimple(new Application(prog.body, UPLCConst.data(dataFromCbor(ctxHex))));
const ok = res?.constructor?.name !== "CEKError";
console.log(ok ? "ACCEPT" : `REJECT: ${(res as { msg?: string })?.msg ?? "?"}`);
