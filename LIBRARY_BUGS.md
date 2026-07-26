# Library bugs (HarmonicLabs off-chain / tooling)

Bugs in HarmonicLabs **libraries** used by this project (wallet, cbor, buildooor, …),
as opposed to the Pebble **compiler** (those live in [PEBBLE_BUGS.md](PEBBLE_BUGS.md)).
Each entry: repro + diagnosis + the workaround applied here + the upstream fix.

---

## LIB BUG 1 — `use-cardano-wallet`: `getBalance()` shows 0 ₳ for token-less wallets

- **Package:** `@harmoniclabs/use-cardano-wallet`
- **Version:** `0.0.3`
- **Severity:** medium — display only (no funds at risk; transactions unaffected)
- **Status:** worked around locally; not yet reported upstream

### Symptom

Connecting a wallet that holds **only ADA and no native tokens** (e.g. a freshly
funded pre-prod test wallet) shows a balance of **`0.0 ₳`**, even though the address
demonstrably holds funds (confirmed on a chain explorer).

Reproduced with `addr_test1qzxaanea3lt06ffrz3ysx5x0hy4hfh5j6lqg8r5wr6rppk3um79qh0z8rlhhajan5qs7cwj8ssf0lwggvsepwtz0u5eqyg9kx5`
(~10,000 ADA, no tokens) → app rendered `0.0 ₳`.

### Root cause

CIP-30 `getBalance()` returns the CBOR encoding of a Cardano `Value`. Per the ledger
CDDL, a `Value` is encoded **one of two ways**:

```
value = coin / [coin, multiasset<uint>]
```

- **only ADA (no tokens)** → a **bare CBOR uint** (the coin)
- **ADA + native tokens** → an **array** `[coin, multiasset]`

`parseBalance` (in `dist/utils.js`) only handles the array form:

```js
export function parseBalance(balance) {
    var cbor = Cbor.parse(balance);
    if (cbor instanceof CborArray && cbor.array[0] instanceof CborUInt)
        return Number(cbor.array[0].num);
    return 0;                     // <-- bare-uint (token-less) balance falls through to 0
}
```

A token-less wallet's balance is a `CborUInt`, not a `CborArray`, so it hits
`return 0`. Wallets that happen to hold any native token encode as the array form and
work by coincidence — which is why the bug is easy to miss in dev wallets full of test
tokens.

### Impact

**Display only.** This project builds transactions from `api.getUtxos()`, not
`getBalance()`, so claim/edit/buy/list all work correctly regardless of this bug — only
the balance pill in the header was wrong.

### Upstream fix (one line)

Add the bare-uint branch to `parseBalance`:

```js
export function parseBalance(balance) {
    var cbor = Cbor.parse(balance);
    if (cbor instanceof CborUInt) return Number(cbor.num);              // <-- add this
    if (cbor instanceof CborArray && cbor.array[0] instanceof CborUInt)
        return Number(cbor.array[0].num);
    return 0;
}
```

(Also consider `BigInt`/`number` precision: a balance above `Number.MAX_SAFE_INTEGER`
lovelace — ~9,007,199 ADA — loses precision through `Number(...)`.)

### Workaround applied here

`website/app/components/WalletBar.tsx` no longer trusts the hook's `lovelaceBalance`.
It reads `api.getBalance()` itself and decodes the coin from **both** encodings with a
tiny dependency-free CBOR uint reader (`lovelaceFromBalanceCbor`), falling back to the
library value only if parsing unexpectedly fails.

---

## LIB BUG 2 — Lace: stale CIP-30 `api` handle → "Remote API … was shutdown"

- **Wallet:** Lace (CIP-30 provider)
- **Related package:** `@harmoniclabs/use-cardano-wallet@0.0.3` (caches the `api` in its store)
- **Severity:** high for Lace users — batch signing can silently fail to prompt
- **Status:** RESOLVED — turned out to be a Lace-side issue (fixed on the wallet's
  end), not our code or a HarmonicLabs library bug. Kept here for history; the UI
  mitigation below shipped and stays regardless.

### Symptom

With Lace connected, starting a claim/edit shows the **"Signing transactions"** modal
but **no wallet prompt ever appears**, and the console logs:

```
Remote API with channel 'cardano-wallet-api' was shutdown: object can no longer be used.
```

The signing flow then stalls (before the × button was added, the modal was un-dismissable).

### Likely cause

Lace exposes its CIP-30 `api` over a message channel that it tears down after some
idle time (or when the extension re-initialises). `use-cardano-wallet` obtains the
`api` **once at connect** and caches it in its zustand store; the app also captures it
early (e.g. Edit's `prebuilderRef.prefetch(api, …)`). If a gap passes between connect
/ prefetch and the actual `signTx`, the cached handle is dead, and the next call on it
throws "object can no longer be used" instead of opening the sign popup.

### Candidate fixes (need testing against Lace)

1. **Re-enable right before signing:** call `window.cardano[walletName].enable()` to get
   a fresh `api` immediately before the `signTx`/`signTxs` batch, instead of reusing the
   cached one.
2. **Retry-once on the shutdown error:** catch `/shutdown|no longer be used/` from
   `signTx`, re-`enable()`, and retry the call one time.
3. Surface a clear, actionable error ("Wallet connection expired — reconnect and try
   again") rather than a silent stall.

### Mitigation shipped

`TxProgress` now has an × button and auto-dismisses after "done", so a stalled batch is
at least dismissable. This does **not** fix the underlying stale-handle problem.
