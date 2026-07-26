// devnet probe: real stewardship init, script INLINE (fast miscompile check).
// OFLAT=<path to flat> overrides the compiled script.
import {
    Value, Hash28, Script, Cbor, CborBytes, DataConstr, DataI, DataB,
    Address, Credential, parseUPLC, compileUPLC, UPLCProgram, Application, UPLCConst,
    type UPLCTerm,
} from "@harmoniclabs/buildooor";
import { queryUtxos, ensureWallet, fundFromGenesis, awaitTxAtAddr, signSubmitAwait, sortedRefIndex, hexToBytes } from "./lib.ts";
import { freeDatum, oMintInit, FREE_TOKEN_NAME } from "./contracts.ts";
import { readFileSync } from "node:fs";

const w = ensureWallet(`probe-${Date.now()}`);
const fundTx = fundFromGenesis([
    { address: w.address, lovelace: 10_000_000n },
    { address: w.address, lovelace: 500_000_000n },
], "fund-oinit");
awaitTxAtAddr(w.address, fundTx);
const utxos = queryUtxos(w.address);
const collateral = utxos.find(u => u.resolved.value.lovelaces === 10_000_000n)!;
const funds = utxos.find(u => u.resolved.value.lovelaces === 500_000_000n)!;

const flatPath = process.env.OFLAT ?? "../out/stewardship/out.flat";
const prog = parseUPLC(new Uint8Array(readFileSync(flatPath)), "flat");
let body: UPLCTerm = prog.body;
body = new Application(body, UPLCConst.data(w.address.toData()));
body = new Application(body, UPLCConst.data(new DataConstr(0, [
    new DataB(hexToBytes(funds.utxoRef.id.toString())), new DataI(Number(funds.utxoRef.index))])));
const outFlat: unknown = compileUPLC(new UPLCProgram(prog.version, body));
const flatBytes = outFlat instanceof Uint8Array ? outFlat
    : new Uint8Array((outFlat as { toBuffer(): Uint8Array }).toBuffer?.() ?? (outFlat as Uint8Array));
const script = Script.plutusV3(Cbor.encode(new CborBytes(flatBytes)));
const policyHex = script.hash.toString();
const address = Address.testnet(Credential.script(script.hash));
console.log("policy:", policyHex);

const gIdx = sortedRefIndex([funds.utxoRef], funds.utxoRef);
await signSubmitAwait({
    inputs: [funds],
    collaterals: [collateral],
    mints: [{
        value: Value.singleAsset(new Hash28(policyHex), FREE_TOKEN_NAME, 1n),
        script: { inline: script, redeemer: oMintInit(gIdx) },
    }],
    outputs: [{
        address,
        value: Value.add(Value.lovelaces(3_000_000n), Value.singleAsset(new Hash28(policyHex), FREE_TOKEN_NAME, 1n)),
        datum: freeDatum({ x0: 0, y0: 0, x1: 1024, y1: 1024 }),
    }],
    changeAddress: w.address,
}, w, "probe-oinit", address);
console.log("STEWARDSHIP INIT (inline) PASSED");
