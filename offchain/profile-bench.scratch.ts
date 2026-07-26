// ===========================================================================
//  Pebble vs Aiken benchmark — SAME transactions, SAME evaluator.
//
//  The Aiken port (aiken-port/) keeps the exact datum/redeemer ABI, so one
//  scenario builder drives both implementations; buildooor evaluates the
//  validators at build time and reports real ex-units. Scenarios mirror the
//  protocol's heavy paths at the live 1024x1022 / 73x14 geometry.
// ===========================================================================
import {
    Address, Credential, PrivateKey, Value, Hash28, Script, TxBuilder, TxOut, TxOutRef,
    UTxO, Cbor, CborBytes, DataConstr, DataI, DataB, parseUPLC, compileUPLC, UPLCProgram,
    Application, UPLCConst, defaultPreprodGenesisInfos,
    type ITxBuildArgs, type UPLCTerm, type Data,
} from "@harmoniclabs/buildooor";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ownershipContract, masterpieceContract, marketplaceContract, buildBmpHeader,
    rootDatum, leafDatum, nurseryDatum, initialChunk, freeDatum, listingDatum,
    rectName, rectArea, txOutRefData,
    mpMintInit, mpCommit, mpEdit, mpHatch, oMintInit, oMintFree, oMintCarve, oClaim,
    mPartialBuy, carveComplements,
    FREE_TOKEN_NAME, LEAF_NFT_NAME, ROOT_REF_NFT_NAME, ROOT_USER_NFT_NAME,
    N_LEAFS, CANVAS_HEIGHT, LOVELACE_PER_PIXEL,
    type Rect, type ContractBundle,
} from "./contracts.ts";
import { cidV1Raw } from "./cid.ts";
import { sortedRefIndex } from "./lib.ts";
import { hexToBytes } from "./lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "website", "config.json"), "utf8"));

// ---- actors / fixtures ----------------------------------------------------
const key = (f: number): PrivateKey => new PrivateKey(new Uint8Array(32).fill(f));
const addrOf = (k: PrivateKey): Address => Address.testnet(Credential.keyHash(k.derivePublicKey().hash));
const owner = addrOf(key(7));
const ownerPkh = key(7).derivePublicKey().hash;
const buyer = addrOf(key(8));
const genesisRef = new TxOutRef({ id: "11".repeat(32), index: 0 });
const bmpHeader = buildBmpHeader();
const ADA = (n: number): bigint => BigInt(n) * 1_000_000n;

let refN = 0x40;
const u = (address: Address, value: Value, datum?: DataConstr): UTxO =>
    new UTxO({ utxoRef: new TxOutRef({ id: (++refN).toString(16).padStart(64, "0"), index: 0 }), resolved: new TxOut({ address, value, datum }) });

// ---- implementations ------------------------------------------------------
interface Impl {
    name: string;
    ownership: ContractBundle;
    masterpiece: ContractBundle;
    marketplace: ContractBundle;
}

// aiken: unwrap blueprint compiledCode (cbor-wrapped flat), apply DATA params
const blueprint = JSON.parse(readFileSync(join(__dirname, "..", "aiken-port", "plutus.json"), "utf8"));
function aikenFlat(name: string): Uint8Array {
    const v = (blueprint.validators as { title: string; compiledCode: string }[])
        .find((x) => x.title.startsWith(`${name}.`));
    if (!v) throw new Error(`validator ${name} not in blueprint`);
    const wrapped = hexToBytes(v.compiledCode);
    const parsed = Cbor.parse(wrapped) as { bytes?: Uint8Array };
    return parsed.bytes instanceof Uint8Array ? parsed.bytes : wrapped;
}
function aikenApply(name: string, params: Data[]): ContractBundle {
    const prog = parseUPLC(aikenFlat(name), "flat");
    let body: UPLCTerm = prog.body;
    for (const p of params) body = new Application(body, UPLCConst.data(p));
    const out: unknown = compileUPLC(new UPLCProgram(prog.version, body));
    const flat = out instanceof Uint8Array ? out
        : new Uint8Array((out as { toBuffer(): Uint8Array }).toBuffer?.() ?? (out as Uint8Array));
    const script = Script.plutusV3(Cbor.encode(new CborBytes(flat)));
    return {
        script, hash: script.hash, policyHex: script.hash.toString(),
        address: Address.testnet(Credential.script(script.hash)),
    };
}

const pebbleOwn = ownershipContract(owner, genesisRef);
const pebble: Impl = {
    name: "pebble",
    ownership: pebbleOwn,
    masterpiece: masterpieceContract(pebbleOwn.hash.toBuffer(), genesisRef, bmpHeader),
    marketplace: marketplaceContract(pebbleOwn.hash.toBuffer()),
};
const aikenOwn = aikenApply("ownership", [owner.toData(), txOutRefData(genesisRef)]);
const aiken: Impl = {
    name: "aiken",
    ownership: aikenOwn,
    masterpiece: aikenApply("masterpiece", [
        new DataB(aikenOwn.hash.toBuffer()), txOutRefData(genesisRef), new DataB(bmpHeader),
    ]),
    marketplace: aikenApply("marketplace", [new DataB(aikenOwn.hash.toBuffer())]),
};

const api = new BlockfrostPluts({ customBackend: (process.env.BLOCKFROST_URL ?? "https://blockfrost-preprod.onchainapps.io"), network: "preprod" });
const txb = new TxBuilder(await api.getProtocolParameters(), defaultPreprodGenesisInfos);

// ---- scenarios ------------------------------------------------------------
const tokens = (policy: string, entries: [Uint8Array, bigint][]): Value =>
    entries.reduce((v, [n, a]) => Value.add(v, Value.singleAsset(new Hash28(policy), n, a)), Value.zero);
const withAda = (l: bigint, v: Value): Value => Value.add(Value.lovelaces(l), v);

const wholeCanvas: Rect = { x0: 0, y0: 0, x1: 1024, y1: CANVAS_HEIGHT };
const claimRect: Rect = { x0: 10, y0: 10, x1: 20, y1: 20 };
const innerRect: Rect = { x0: 12, y0: 13, x1: 17, y1: 18 };

const initCids = Array.from({ length: N_LEAFS }, () => cidV1Raw(initialChunk()));

type Scenario = (impl: Impl) => ITxBuildArgs;
const scenarios: Record<string, Scenario> = {
    "masterpiece init": (impl) => {
        const genesisU = new UTxO({ utxoRef: genesisRef, resolved: new TxOut({ address: owner, value: Value.lovelaces(ADA(50)) }) });
        const mp = impl.masterpiece;
        const funding = u(owner, Value.lovelaces(ADA(200)));
        const gIdx = sortedRefIndex([genesisRef, funding.utxoRef], genesisRef);
        return {
            inputs: [genesisU, funding],
            collaterals: [u(owner, Value.lovelaces(ADA(10)))],
            mints: [{
                value: tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)], [ROOT_REF_NFT_NAME, 1n], [ROOT_USER_NFT_NAME, 1n]]),
                script: { inline: mp.script, redeemer: mpMintInit(gIdx) },
            }],
            outputs: [
                { address: mp.address, value: withAda(ADA(15), tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]])), datum: nurseryDatum(0) },
                { address: mp.address, value: withAda(ADA(30), tokens(mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]])), datum: rootDatum(initCids, bmpHeader).data },
                { address: owner, value: withAda(ADA(2), tokens(mp.policyHex, [[ROOT_USER_NFT_NAME, 1n]])) },
            ],
            changeAddress: owner,
        };
    },
    "hatch leaf 0": (impl) => {
        const mp = impl.masterpiece;
        const nursery = u(mp.address, withAda(ADA(15), tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS)]])), nurseryDatum(0));
        return {
            inputs: [
                { utxo: nursery, inputScript: { script: mp.script, datum: "inline", redeemer: mpHatch() } },
                u(owner, Value.lovelaces(ADA(200))),
            ],
            collaterals: [u(owner, Value.lovelaces(ADA(10)))],
            outputs: [
                { address: mp.address, value: withAda(ADA(70), tokens(mp.policyHex, [[LEAF_NFT_NAME, 1n]])), datum: leafDatum(0, initialChunk()) },
                { address: mp.address, value: withAda(ADA(15), tokens(mp.policyHex, [[LEAF_NFT_NAME, BigInt(N_LEAFS - 1)]])), datum: nurseryDatum(1) },
            ],
            changeAddress: owner,
        };
    },
    "commit 1 leaf": (impl) => {
        const mp = impl.masterpiece;
        const root = u(mp.address, withAda(ADA(30), tokens(mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]])), rootDatum(initCids, bmpHeader).data);
        const leaf = u(mp.address, withAda(ADA(70), tokens(mp.policyHex, [[LEAF_NFT_NAME, 1n]])), leafDatum(0, initialChunk()));
        return {
            inputs: [
                { utxo: root, inputScript: { script: mp.script, datum: "inline", redeemer: mpCommit([0]) } },
                u(owner, Value.lovelaces(ADA(200))),
            ],
            readonlyRefInputs: [leaf],
            collaterals: [u(owner, Value.lovelaces(ADA(10)))],
            outputs: [{
                address: mp.address, value: withAda(ADA(30), tokens(mp.policyHex, [[ROOT_REF_NFT_NAME, 1n]])),
                datum: rootDatum(initCids, bmpHeader).data,
            }],
            changeAddress: owner,
        };
    },
    "edit leaf 0 (4px)": (impl) => {
        const mp = impl.masterpiece;
        const oldChunk = initialChunk();
        const newChunk = new Uint8Array(oldChunk);
        for (let y = 10; y < 12; y++) for (let x = 10; x < 12; x++) newChunk[y * 1024 + x] = 0;
        const leaf = u(mp.address, withAda(ADA(70), tokens(mp.policyHex, [[LEAF_NFT_NAME, 1n]])), leafDatum(0, oldChunk));
        const deed = u(owner, withAda(ADA(2), tokens(impl.ownership.policyHex, [[rectName(claimRect), 1n]])));
        return {
            inputs: [
                { utxo: leaf, inputScript: { script: mp.script, datum: "inline", redeemer: mpEdit([claimRect]) } },
                u(owner, Value.lovelaces(ADA(200))),
            ],
            readonlyRefInputs: [deed],
            requiredSigners: [ownerPkh],
            collaterals: [u(owner, Value.lovelaces(ADA(10)))],
            outputs: [{
                address: mp.address, value: withAda(ADA(70), tokens(mp.policyHex, [[LEAF_NFT_NAME, 1n]])),
                datum: leafDatum(0, newChunk),
            }],
            changeAddress: owner,
        };
    },
    "claim 10x10 (4 comps)": (impl) => {
        const own = impl.ownership;
        const freeNode = u(own.address, withAda(ADA(3), tokens(own.policyHex, [[FREE_TOKEN_NAME, 1n]])), freeDatum(wholeCanvas));
        const comps = carveComplements(wholeCanvas, claimRect);
        return {
            inputs: [
                { utxo: freeNode, inputScript: { script: own.script, datum: "inline", redeemer: oClaim(claimRect) } },
                u(owner, Value.lovelaces(ADA(600))),
            ],
            collaterals: [u(owner, Value.lovelaces(ADA(10)))],
            mints: [{
                value: tokens(own.policyHex, [[rectName(claimRect), 1n], [FREE_TOKEN_NAME, BigInt(comps.length - 1)]]),
                script: { inline: own.script, redeemer: oMintFree() },
            }],
            outputs: [
                ...comps.map((r) => ({ address: own.address, value: withAda(ADA(3), tokens(own.policyHex, [[FREE_TOKEN_NAME, 1n]])), datum: freeDatum(r) })),
                { address: owner, value: Value.lovelaces(rectArea(claimRect) * LOVELACE_PER_PIXEL) },
                { address: owner, value: withAda(ADA(2), tokens(own.policyHex, [[rectName(claimRect), 1n]])) },
            ],
            changeAddress: owner,
        };
    },
    "partialBuy (carve, 4 relists)": (impl) => {
        const own = impl.ownership, mkt = impl.marketplace;
        const ppp = ADA(1);
        const listing = u(mkt.address, withAda(ADA(2), tokens(own.policyHex, [[rectName(claimRect), 1n]])), listingDatum(owner, ppp));
        const comps = carveComplements(claimRect, innerRect);
        const mintEntries: [Uint8Array, bigint][] = [
            [rectName(claimRect), -1n], [rectName(innerRect), 1n],
            ...comps.map((c): [Uint8Array, bigint] => [rectName(c), 1n]),
        ];
        return {
            inputs: [
                { utxo: listing, inputScript: { script: mkt.script, datum: "inline", redeemer: mPartialBuy(claimRect, innerRect) } },
                u(buyer, Value.lovelaces(ADA(200))),
            ],
            collaterals: [u(buyer, Value.lovelaces(ADA(10)))],
            mints: [{
                value: tokens(own.policyHex, mintEntries),
                script: { inline: own.script, redeemer: oMintCarve(claimRect, innerRect) },
            }],
            outputs: [
                ...comps.map((c) => ({ address: mkt.address, value: withAda(ADA(2), tokens(own.policyHex, [[rectName(c), 1n]])), datum: listingDatum(owner, ppp) })),
                { address: owner, value: Value.lovelaces(ppp * rectArea(innerRect)), datum: txOutRefData(listing.utxoRef) },
                { address: buyer, value: withAda(ADA(2), tokens(own.policyHex, [[rectName(innerRect), 1n]])) },
            ],
            changeAddress: buyer,
        };
    },
    "ownership init": (impl) => {
        const own = impl.ownership;
        const genesisU = new UTxO({ utxoRef: genesisRef, resolved: new TxOut({ address: owner, value: Value.lovelaces(ADA(50)) }) });
        const funding = u(owner, Value.lovelaces(ADA(200)));
        const gIdx = sortedRefIndex([genesisRef, funding.utxoRef], genesisRef);
        return {
            inputs: [genesisU, funding],
            collaterals: [u(owner, Value.lovelaces(ADA(10)))],
            mints: [{
                value: tokens(own.policyHex, [[FREE_TOKEN_NAME, 1n]]),
                script: { inline: own.script, redeemer: oMintInit(gIdx) },
            }],
            outputs: [{
                address: own.address, value: withAda(ADA(3), tokens(own.policyHex, [[FREE_TOKEN_NAME, 1n]])),
                datum: freeDatum(wholeCanvas),
            }],
            changeAddress: owner,
        };
    },
};

// ---- run ------------------------------------------------------------------
process.env.PEBBLE_PROFILE = "1";
import { UPLCBuiltinTag } from "@harmoniclabs/uplc";
function dumpProfile( label: string ): void {
    const g: any = globalThis as any;
    const prof = g.__cekProfile;
    g.__cekProfile = undefined;
    if( !prof ) { console.log(label, "(no profile)"); return; }
    const stepNames: Record<string,string> = { "0":"Var","1":"Delay","2":"Lambda","3":"Apply","4":"Const","5":"Force","6":"Error","7":"Builtin","8":"Constr","9":"Case" };
    const steps = Object.entries(prof.steps as Record<string,number>).map(([k,v]) => `${stepNames[k] ?? k}:${v}`).join(" ");
    console.log(`\n== ${label}`);
    console.log("   steps:", steps);
    const rows = Object.entries(prof.builtins as Record<string, {n:number,cpu:bigint,mem:bigint}>)
        .map(([tag, e]) => ({ name: (UPLCBuiltinTag as any)[Number(tag)] ?? tag, ...e }))
        .sort((a,b) => Number(b.cpu - a.cpu));
    for( const r of rows.slice(0, 12) )
        console.log("   " + String(r.name).padEnd(26), "n:", String(r.n).padStart(7), "cpu:", (Number(r.cpu)/1e6).toFixed(1).padStart(9)+"M", "mem:", (Number(r.mem)/1e3).toFixed(0).padStart(8)+"k");
}
interface Ex { cpu: number; mem: number; }
async function run(impl: Impl, name: string): Promise<Ex[] | string> {
    try {
        (globalThis as any).__cekProfile = undefined;
        const tx = await txb.build(scenarios[name](impl));
        dumpProfile(`${name} [${impl.name}]`);
        return (tx.witnesses.redeemers ?? []).map((r) => {
            const ex = r.execUnits as unknown as { mem: bigint | number; cpu?: bigint | number; steps?: bigint | number };
            return { cpu: Number(ex.cpu ?? ex.steps ?? 0), mem: Number(ex.mem ?? 0) };
        });
    } catch (e) {
        const m = String((e as Error).message).match(/error message: ([^\n]*)/);
        return `FAILED: ${(m?.[1] ?? String((e as Error).message).split("\n")[0]).slice(0, 70)}`;
    }
}

const fmtB = (n: number): string => `${(n / 1e9).toFixed(2)}B`;
const fmtM = (n: number): string => `${(n / 1e6).toFixed(2)}M`;

console.log("script sizes (applied, cbor-wrapped bytes):");
for (const c of ["ownership", "masterpiece", "marketplace"] as const) {
    const p = pebble[c].script.bytes.length, a = aiken[c].script.bytes.length;
    console.log(`  ${c.padEnd(12)} pebble ${String(p).padStart(6)}  aiken ${String(a).padStart(6)}  (${(a / p * 100).toFixed(0)}%)`);
}
console.log("\nex-units per scenario (sum over all redeemers in the tx):");
for (const name of Object.keys(scenarios)) {
    const line = [`  ${name.padEnd(30)}`];
    for (const impl of [pebble, aiken]) {
        const r = await run(impl, name);
        if (typeof r === "string") line.push(`${impl.name}: ${r}`);
        else {
            const cpu = r.reduce((s, x) => s + x.cpu, 0), mem = r.reduce((s, x) => s + x.mem, 0);
            line.push(`${impl.name} cpu ${fmtB(cpu).padStart(7)} mem ${fmtM(mem).padStart(8)}`);
        }
    }
    console.log(line.join("  |  "));
}
