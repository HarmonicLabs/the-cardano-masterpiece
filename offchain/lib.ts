// ===========================================================================
//  Masterpiece offchain — shared glue (buildooor + local cardano-node devnet)
// ===========================================================================
//
//  buildooor BUILDS, EVALUATES (plutus-machine) and SIGNS the transactions;
//  the local cardano-node is reached through `cardano-cli` for:
//    * query UTxOs / protocol params
//    * submit signed txs
// ===========================================================================

import {
    Script, Address, Credential, Value, TxBuilder, UTxO, TxOutRef, TxOut,
    PrivateKey, PublicKey, PubKeyHash, Hash28, Tx, CborPositiveRational,
    dataFromCbor, defaultProtocolParameters,
    type ITxBuildArgs,
} from "@harmoniclabs/buildooor";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

export const DEVNET = join(ROOT, ".devnet", "data");
export const SOCKET = join(DEVNET, "socket", "node1", "sock");
export const MAGIC = 42;
export const WALLET_DIR = join(ROOT, ".devnet", "wallets");
export const WORK = join(ROOT, ".devnet", "work");
if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });

export const hexToBytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));
export const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

// ---------------------------------------------------------------------------
//  Language-view shim: serialize the script-integrity cost models exactly as
//  the node reports them (no padding), so the integrity hash always matches.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
{
    const CM = _require("@harmoniclabs/cardano-costmodels-ts/dist/CostModels.js");
    const { Cbor, CborMap, CborUInt, CborNegInt, CborArray, CborBytes } = _require("@harmoniclabs/cbor");
    const ppPath = join(DEVNET, "pparams.json");
    if (existsSync(ppPath)) {
        const pp = JSON.parse(readFileSync(ppPath, "utf8"));
        const cn = (n: number | string) =>
            (BigInt(n) < 0n ? new CborNegInt(BigInt(n)) : new CborUInt(BigInt(n)));
        CM.costModelsToLanguageViewCbor = function (
            _costmdls: unknown,
            opts: { mustHaveV1?: boolean; mustHaveV2?: boolean; mustHaveV3?: boolean }
        ) {
            const entries: unknown[] = [];
            if (opts.mustHaveV1) entries.push({
                k: new CborBytes(Uint8Array.from([0])),
                v: new CborBytes(Cbor.encode(new CborArray(pp.costModels.PlutusV1.map(cn), { indefinite: true }))),
            });
            if (opts.mustHaveV2) entries.push({ k: new CborUInt(1), v: new CborArray(pp.costModels.PlutusV2.map(cn)) });
            if (opts.mustHaveV3) entries.push({ k: new CborUInt(2), v: new CborArray(pp.costModels.PlutusV3.map(cn)) });
            return Cbor.encode(new CborMap(entries));
        };
    }
}

// ---- cardano-cli wrappers -------------------------------------------------

export function cli(args: string[], opts: object = {}): string {
    return execFileSync("cardano-cli", args, {
        env: { ...process.env, CARDANO_NODE_SOCKET_PATH: SOCKET },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        ...opts,
    });
}

export function queryTip(): { block: number; slot: number; syncProgress: string } {
    return JSON.parse(cli(["query", "tip", "--testnet-magic", String(MAGIC)]));
}

interface CliValue {
    lovelace?: number | string;
    [policy: string]: unknown;
}

function valueFromCli(v: CliValue): Value {
    let acc = Value.lovelaces(BigInt(v.lovelace ?? 0));
    for (const [policy, toks] of Object.entries(v)) {
        if (policy === "lovelace") continue;
        for (const [name, amt] of Object.entries(toks as Record<string, number | string>)) {
            acc = Value.add(acc, Value.singleAsset(new Hash28(policy), hexToBytes(name), BigInt(amt)));
        }
    }
    return acc;
}

interface CliUtxo {
    address: string;
    value: CliValue;
    inlineDatumRaw?: string;
    referenceScript?: { script?: { cborHex?: string } };
}

// returns array of buildooor UTxO objects at `address`
export function queryUtxos(address: Address | string): UTxO[] {
    const addr = typeof address === "string" ? address : address.toString();
    const tmp = join(WORK, ".utxo-query.json");
    cli(["query", "utxo", "--address", addr, "--testnet-magic", String(MAGIC), "--out-file", tmp]);
    const raw: Record<string, CliUtxo> = JSON.parse(readFileSync(tmp, "utf8"));
    const out: UTxO[] = [];
    for (const [ref, o] of Object.entries(raw)) {
        const [txid, ix] = ref.split("#");
        const datum = o.inlineDatumRaw ? dataFromCbor(o.inlineDatumRaw) : undefined;
        const refScript = o.referenceScript?.script?.cborHex
            ? Script.plutusV3(hexToBytes(o.referenceScript.script.cborHex))
            : undefined;
        out.push(new UTxO({
            utxoRef: new TxOutRef({ id: txid, index: Number(ix) }),
            resolved: new TxOut({
                address: Address.fromString(o.address),
                value: valueFromCli(o.value),
                datum,
                refScript,
            }),
        }));
    }
    return out;
}

export function submitSignedTx(signedTx: Tx, label = "tx"): string {
    const cborHex = bytesToHex(signedTx.toCborBytes());
    const env = { type: "Tx ConwayEra", description: "", cborHex };
    const f = join(WORK, `${label}.signed.json`);
    writeFileSync(f, JSON.stringify(env));
    cli(["latest", "transaction", "submit", "--testnet-magic", String(MAGIC), "--tx-file", f]);
    return signedTx.hash.toString();
}

export function sleep(ms: number): void {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
}

// wait until `txHash` shows up as a UTxO at `address`
export function awaitTxAtAddr(address: Address | string, txHash: string, tries = 120): UTxO[] {
    for (let i = 0; i < tries; i++) {
        const utxos = queryUtxos(address);
        if (utxos.some((u) => u.utxoRef.id.toString() === txHash)) return utxos;
        sleep(1000);
    }
    throw new Error(`timeout waiting for tx ${txHash} at ${address}`);
}

// ---- protocol params / tx builder -----------------------------------------

let _txb: TxBuilder | undefined;
export function txBuilder(): TxBuilder {
    if (_txb) return _txb;
    const pp = JSON.parse(readFileSync(join(DEVNET, "pparams.json"), "utf8"));
    _txb = new TxBuilder({
        ...defaultProtocolParameters,
        txFeePerByte: pp.txFeePerByte,
        txFeeFixed: pp.txFeeFixed,
        utxoCostPerByte: pp.utxoCostPerByte,
        maxTxSize: pp.maxTxSize,
        collateralPercentage: pp.collateralPercentage,
        maxCollateralInputs: pp.maxCollateralInputs,
        minfeeRefScriptCostPerByte: new CborPositiveRational(BigInt(pp.minFeeRefScriptCostPerByte ?? 15), 1n),
    });
    return _txb;
}

// ---- wallets --------------------------------------------------------------

export interface Wallet {
    name: string;
    prv: PrivateKey;
    pub: PublicKey;
    pkh: PubKeyHash;
    address: Address;
}

export function saveWallet(name: string, seed32: Uint8Array): Wallet {
    if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(
        join(WALLET_DIR, `${name}.json`),
        JSON.stringify({ skeyHex: bytesToHex(seed32) }, null, 2)
    );
    return loadWallet(name);
}

export function loadWallet(name: string): Wallet {
    const w = JSON.parse(readFileSync(join(WALLET_DIR, `${name}.json`), "utf8"));
    const prv = new PrivateKey(hexToBytes(w.skeyHex));
    const pub = prv.derivePublicKey();
    const address = Address.testnet(Credential.keyHash(pub.hash));
    return { name, prv, pub, pkh: pub.hash, address };
}

export function ensureWallet(name: string): Wallet {
    if (existsSync(join(WALLET_DIR, `${name}.json`))) return loadWallet(name);
    return saveWallet(name, globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// ---- funding from the devnet genesis utxo key -----------------------------

export interface FundOut { address: Address | string; lovelace: bigint; }

export function fundFromGenesis(outs: FundOut[], label = "fund"): string {
    const genSkey = join(DEVNET, "utxo-keys", "utxo1", "utxo.skey");
    const genVkey = join(DEVNET, "utxo-keys", "utxo1", "utxo.vkey");
    const genAddrFile = join(WORK, "genesis.addr");
    if (!existsSync(genAddrFile)) {
        const a = cli(["address", "build", "--payment-verification-key-file", genVkey, "--testnet-magic", String(MAGIC)]);
        writeFileSync(genAddrFile, a.trim());
    }
    const genAddr = readFileSync(genAddrFile, "utf8").trim();

    const tmp = join(WORK, "gen-utxo.json");
    cli(["query", "utxo", "--address", genAddr, "--testnet-magic", String(MAGIC), "--out-file", tmp]);
    const utxos: Record<string, { value: { lovelace: number | string } }> = JSON.parse(readFileSync(tmp, "utf8"));
    const entries = Object.entries(utxos).sort((a, b) => Number(b[1].value.lovelace) - Number(a[1].value.lovelace));
    if (entries.length === 0) throw new Error("genesis address has no utxos");
    const [inRef] = entries[0];

    const txFile = join(WORK, `${label}.tx`);
    const args = [
        "conway", "transaction", "build",
        "--testnet-magic", String(MAGIC),
        "--tx-in", inRef,
        "--change-address", genAddr,
        "--out-file", txFile,
    ];
    for (const o of outs) {
        args.push("--tx-out", `${typeof o.address === "string" ? o.address : o.address.toString()}+${o.lovelace}`);
    }
    cli(args);
    const signedFile = join(WORK, `${label}.signed`);
    cli(["conway", "transaction", "sign", "--testnet-magic", String(MAGIC),
        "--tx-file", txFile, "--signing-key-file", genSkey, "--out-file", signedFile]);
    cli(["conway", "transaction", "submit", "--testnet-magic", String(MAGIC), "--tx-file", signedFile]);
    const rawId = cli(["conway", "transaction", "txid", "--tx-file", signedFile]).trim();
    try { return JSON.parse(rawId).txhash; } catch { return rawId; }
}

// ---- misc -----------------------------------------------------------------

// the ledger orders the tx input set lexicographically by (txid, index):
// returns the position `ref` will occupy among `refs`
export function sortedRefIndex(refs: TxOutRef[], ref: TxOutRef): number {
    const key = (r: TxOutRef) => `${r.id.toString()}#${String(r.index).padStart(10, "0")}`;
    return [...refs].map(key).sort().indexOf(key(ref));
}

type ValueJson = Record<string, Record<string, string | number | bigint>>;

export function findUtxoWithAsset(utxos: UTxO[], policyHex: string, nameBytes: Uint8Array): UTxO | undefined {
    return utxos.find((u) => {
        const j = u.resolved.value.toJson() as ValueJson;
        const p = j[policyHex];
        return p !== undefined && BigInt(p[bytesToHex(nameBytes)] ?? 0n) > 0n;
    });
}

export function assetAmount(utxo: UTxO, policyHex: string, nameBytes: Uint8Array): bigint {
    const j = utxo.resolved.value.toJson() as ValueJson;
    return BigInt(j[policyHex]?.[bytesToHex(nameBytes)] ?? 0n);
}

export function pureAdaUtxo(utxos: UTxO[], min = 5_000_000n): UTxO | undefined {
    return utxos.find((u) => {
        const j = u.resolved.value.toJson() as ValueJson;
        return Object.keys(j).length === 1 && j[""] !== undefined && BigInt(j[""][""]) >= min;
    });
}

// build + evaluate + sign + submit, waiting for inclusion at `waitAddr`
export async function signSubmitAwait(
    buildArgs: ITxBuildArgs,
    wallet: Wallet,
    label: string,
    waitAddr?: Address | string
): Promise<string> {
    const tx = await txBuilder().build(buildArgs);
    tx.signWith(wallet.prv);
    const h = submitSignedTx(tx, label);
    console.log(`  [${label}] submitted ${h}`);
    if (waitAddr) awaitTxAtAddr(waitAddr, h);
    return h;
}
