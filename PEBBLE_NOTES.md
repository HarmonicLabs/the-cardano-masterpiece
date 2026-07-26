# Pebble — confirmed usage facts and idioms (not bugs)

## Lambdas close over CONSTANTS only

Language rule (author): a lambda may access `const` bindings and its own
parameters. A `const` computes ONCE at declaration (a UPLC let-binding); the lambda
accesses a plain variable — `filter( o => o.address == ownAddr )` is the idiomatic,
efficient form. Accessing a mutable `let` from a lambda is invalid and will become a
COMPILE ERROR. (`for` loop bodies compile to recursive lambdas; loop-carried `let`
state is threaded as loop arguments, which is fine.)

CAVEAT until PEBBLE_BUGS.md BUG 16 is fixed: the current compiler VIOLATES the
compute-once guarantee — const values referenced inside lambdas get inlined and
re-evaluated per element. Until the fix lands, keep expensive computations
(hashing, list decoding, CID assembly) out of anything a lambda or loop body
references.

Audit of this repo (2026-07-23): every lambda captures only `const` bindings,
context vars, or params — compliant with the rule; verified within budget by the
devnet e2e. The init `every`-check removed as a BUG 16 workaround can be restored
once compute-once holds.

## Parameter ABI (off-chain application)

Scalar `param`s (`bytes`, `int`) apply as NATIVE UPLC constants
(`UPLCConst.byteString` / `UPLCConst.int`); data-encoded types (Address, TxOutRef,
user structs) apply as `UPLCConst.data`. Wrapping a scalar in Data miscompiles at a
distance. See `offchain/contracts.mjs` `applyParams`.

## Multi-state datum encoding

With ≥2 `state` blocks the datum is `Constr(stateIndex, fields)` in declaration
order — consistent between the spend dispatch and `as Contract` casts. Avoid
single-state contracts that inspect their own datums until PEBBLE_BUGS.md BUG 17 is
fixed (the shortcut ABI disagrees between the two paths); a dummy second state
forces the explicit encoding.

## Redeemer wrapping

Every method redeemer is wrapped in a method-selector constructor:
`Constr methodIndex [ args… ]` — per purpose for contract-level methods (mint
methods in declaration order), per state for state spend methods (single method ⇒
`Constr 0 [ args ]`).
