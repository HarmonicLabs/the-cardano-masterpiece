// ===========================================================================
//  Chain provider abstraction: local devnet (cardano-cli) or preprod
//  (Blockfrost via @harmoniclabs/blockfrost-pluts, buildooor-compatible).
//  Select with BACKEND=devnet|preprod (default devnet).
// ===========================================================================
import {
    Address, TxBuilder, UTxO, Tx, PrivateKey, Credential,
    defaultProtocolParameters, CborPositiveRational,
    defaultPreprodGenesisInfos,
} from "@harmoniclabs/buildooor";
import { BlockfrostPluts } from "@harmoniclabs/blockfrost-pluts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    ROOT, DEVNET, hexToBytes,
    queryUtxos as devnetQueryUtxos,
    submitSignedTx as devnetSubmit,
    sleep, type Wallet,
} from "./lib.ts";

export type Backend = "devnet" | "preprod";

export interface ChainProvider {
    readonly backend: Backend;
    queryUtxos(address: Address | string): Promise<UTxO[]>;
    submit(tx: Tx, label: string): Promise<string>;
    /** wait until `txHash` appears as a utxo at `address` */
    awaitTx(address: Address | string, txHash: string): Promise<void>;
    txBuilder(): Promise<TxBuilder>;
}

export const BLOCKFROST_PREPROD_URL = "https://blockfrost-preprod.onchainapps.io";

// ---- devnet ---------------------------------------------------------------

function makeDevnetProvider(): ChainProvider {
    let _txb: TxBuilder | undefined;
    return {
        backend: "devnet",
        async queryUtxos(address) { return devnetQueryUtxos(address); },
        async submit(tx, label) { return devnetSubmit(tx, label); },
        async awaitTx(address, txHash) {
            for (let i = 0; i < 120; i++) {
                const utxos = devnetQueryUtxos(address);
                if (utxos.some((u) => u.utxoRef.id.toString() === txHash)) return;
                sleep(1000);
            }
            throw new Error(`devnet: timeout waiting for tx ${txHash}`);
        },
        async txBuilder() {
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
        },
    };
}

// ---- preprod (blockfrost) -------------------------------------------------

function makePreprodProvider(): ChainProvider {
    const api = new BlockfrostPluts({ customBackend: BLOCKFROST_PREPROD_URL, network: "preprod" });
    let _txb: TxBuilder | undefined;
    return {
        backend: "preprod",
        async queryUtxos(address) {
            const addr = typeof address === "string" ? address : address.toString();
            try {
                return await api.addressUtxos(addr as `addr_test1${string}`);
            } catch (e) {
                // blockfrost 404s on never-seen addresses
                if (String(e).includes("404")) return [];
                throw e;
            }
        },
        async submit(tx, label) {
            const h = await api.submitTx(tx);
            void label;
            return typeof h === "string" ? h : tx.hash.toString();
        },
        async awaitTx(address, txHash) {
            // preprod blocks every ~20s + indexing lag: poll for ~10 minutes
            for (let i = 0; i < 120; i++) {
                const utxos = await this.queryUtxos(address);
                if (utxos.some((u) => u.utxoRef.id.toString() === txHash)) return;
                sleep(5000);
            }
            throw new Error(`preprod: timeout waiting for tx ${txHash} at ${address}`);
        },
        async txBuilder() {
            if (_txb) return _txb;
            const pp = await api.getProtocolParameters();
            _txb = new TxBuilder(pp, defaultPreprodGenesisInfos);
            return _txb;
        },
    };
}

export function getProvider(backend?: Backend): ChainProvider {
    const b: Backend = backend ?? (process.env.BACKEND === "preprod" ? "preprod" : "devnet");
    return b === "preprod" ? makePreprodProvider() : makeDevnetProvider();
}

// ---- preprod wallet (offchain/keys/) --------------------------------------

// loads the cardano-cli envelope key: cborHex = 5820 || 32-byte ed25519 seed
export function loadPreprodWallet(): Wallet {
    const keysDir = join(ROOT, "offchain", "keys");
    const skeyEnv = JSON.parse(readFileSync(join(keysDir, "preprod.skey"), "utf8"));
    const cborHex: string = skeyEnv.cborHex;
    if (!cborHex.startsWith("5820")) throw new Error("unexpected skey cbor: " + cborHex.slice(0, 8));
    const prv = new PrivateKey(hexToBytes(cborHex.slice(4)));
    const pub = prv.derivePublicKey();
    const address = Address.testnet(Credential.keyHash(pub.hash));
    const expected = readFileSync(join(keysDir, "preprod.addr"), "utf8").trim();
    if (address.toString() !== expected)
        throw new Error(`derived address ${address} != keys/preprod.addr ${expected}`);
    return { name: "preprod", prv, pub, pkh: pub.hash, address };
}
