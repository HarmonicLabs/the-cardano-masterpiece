# Mainnet deployment checklist

Everything needed to launch The Cardano Masterpiece on **mainnet**. Prep is
already done in the repo (contracts, deploy script, network-aware website); this
is the runbook for the actual funded launch.

> ⚠️ Mainnet is real ADA and mostly irreversible. Deploying locks **~120 ADA
> forever** in the three reference scripts. Do a full dry run on preprod with
> these exact values first.

## Launch parameters (already set)

| Parameter | Value | Where |
|---|---|---|
| Protocol steward | `addr1qy7aq92yfxew05t59870yuj4z2lzl078v7zu96m22uvfgyrcuykx0e2rn3lqhvm0ngx0hhwyydf3cyw2n987t3w7m6qqaz89xl` | `offchain/deploy-mainnet.ts` (`MAINNET_STEWARD`), overridable via `PROTOCOL_STEWARD` |
| Initial price | **2.5 ADA/px** | `LOVELACE_PER_PIXEL` (written to the price-config datum at genesis) |
| Price floor | **0.5 ADA/px** (contract-enforced) | `MIN_LOVELACE_PER_PIXEL` in `src/stewardship.pebble` |
| Canvas | 1008×1008, 84 leaves | contract constant `N_LEAFS` |
| Chain access | public mainnet proxy `https://blockfrost-mainnet.onchainapps.io` | override with `BLOCKFROST_URL` |

Note: the 0.5 floor is **contract-enforced**, so the mainnet stewardship script
is a fresh build (flat sha256 `0965110…`), different from the deployed preprod
one (min 1 ADA, `94fa282…`). Marketplace + masterpiece flat bytes are unchanged;
their applied policy hashes still differ because they embed the stewardship hash.

## Status: verified on devnet

The min-0.5 / initial-2.5 contracts passed the **full devnet e2e + adversarial
suite** (ownership incl. the 0.5-ADA floor boundary, marketplace, masterpiece,
multi-leaf commit) — all green.

## Prerequisites (you provide)

1. **Deployer wallet** — `offchain/keys/mainnet.skey` + `offchain/keys/mainnet.addr`
   (cardano-cli payment key envelope, same format as `preprod.skey`). Fund it with
   **~1000 ADA in one pure-ada utxo** — ~120 ADA stays locked in the ref scripts,
   the rest returns as change. This is a hot key; move remaining funds out after.
2. **Chain access** — the public mainnet proxy is the default. To use your own
   blockfrost.io mainnet key, set `BLOCKFROST_URL` (offchain) and the Vercel env.
3. **IPFS pinning** — the existing Filebase bucket + keys work for mainnet
   (`FILEBASE_KEY` / `FILEBASE_SECRET` / `FILEBASE_BUCKET`).

## Deploy steps

```bash
# 1. compile the contracts (min 0.5) — verify the stewardship flat sha256
npm run compile:local
sha256sum out/stewardship/out.flat   # expect 0965110...

# 2. genesis deploy (writes website/config.json with network:"mainnet")
cd offchain
BACKEND=mainnet npx tsx deploy-mainnet.ts

# 3. hatch all 84 leaves
BACKEND=mainnet npx tsx hatch-all.ts
```

`deploy-mainnet.ts` overwrites `website/config.json` with the fresh mainnet
policies/addresses + `network: "mainnet"`. Commit that file.

## Website (Vercel) env — set BEFORE the config.json switch goes live

| Var | Value |
|---|---|
| `BLOCKFROST_URL` | mainnet endpoint (proxy or your blockfrost.io mainnet URL) |
| `BLOCKFROST_PROJECT_ID` | only if using blockfrost.io directly (else leave unset for the proxy) |
| `FILEBASE_KEY` / `FILEBASE_SECRET` / `FILEBASE_BUCKET` | IPFS pinning (unchanged) |

The website is already network-aware: with `config.network === "mainnet"` it uses
`defaultMainnetGenesisInfos`, mainnet address parsing, the mainnet Blockfrost
network, and the 2.5 / 0.5 price constants automatically.

## Pre-flight checklist

- [ ] Full preprod dry run with `deploy-preprod.ts` on the min-0.5 build passed
- [ ] `keys/mainnet.skey` derives `keys/mainnet.addr` and holds ≥1000 ADA (one utxo)
- [ ] Steward address in `deploy-mainnet.ts` double-checked (funds route there)
- [ ] `out/stewardship/out.flat` sha256 == `0965110…` (min-0.5 build)
- [ ] Vercel mainnet env vars set
- [ ] `re-audit` of the one-line floor change (1→0.5 ADA) in `stewardship.pebble`
- [ ] Decide whether to lock the (222) root NFT (see the "send and lock" discussion) or keep it with the steward
