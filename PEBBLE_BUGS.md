# Pebble — open bugs found while building this project

Bugs 1–10 found against published 0.3.5 (context vars in struct literals, `let`
accumulators in `if` branches, struct-param functions crashing hoisting, `export
const`, `LinearMap` as struct-field type, derived consts, nested index
expressions, state types not castable, per-call-site function inlining) are all
**FIXED in published 0.3.6** and have been removed from this file. What follows
is still open against `@harmoniclabs/pebble` **0.3.6** (`b81b077`).

## FIXED in pebble 0.4.1 — BUG 26 (CRITICAL, security): an effect-only loop was DELETED

**Root cause (compiler side, diagnosed after this report):** not the
`Some{…}` destructure. The `edit` guard's loop reassigns exactly ONE
variable (`refRects`, walked with `.tail()`), and that variable is DEAD
after the loop — so the loop exists only for its asserts' effect. The
"bare loop result" lowering in `expressify` bound the loop's result as a
LETTED constant, and letteds only materialize where they are referenced:
with no reference, the binding — and with it the ENTIRE LOOP, asserts
included — never reached the output. The compiled `masterpiece` script was
434 bytes smaller than it should have been, and the reduced repro below
compiled to a 36-byte "always accept" script.

Downstream dead-code elimination could not have caught it either:
`isSafeToEagerlyEvaluate` reports a loop CALL total, because a loop is a
fixpoint `(λrecBody. … recBody …) loopBodyFunc` and the walker treats that
body as an unapplied, never-runs argument. (Tightening that predicate is
unsafe for performance — it would stop `const`s built from recursive
helpers from floating out of closures, the BUG 16 / BUG 24 compute-once
regressions — so it is documented there instead of changed.)

**Fix (pebble 0.4.1):** take the bare-lowering shortcut only when the reassigned variable
is actually READ after the loop; otherwise keep the SoP path, where the
loop call is an `IRCase` scrutinee and therefore always evaluated.
Perf-neutral (A/B on this benchmark: init 1.33B/3.18M, hatch 0.44B/0.37M,
commit 1.56B/4.64M, partialBuy 0.60B/1.01M — identical before/after);
`masterpiece` grows 4727 → 5161 bytes, which is the restored check.

Covered by 13 tests in
`compiler.masterpieceBugs.0_4_0.effectOnlyLoop.test.ts` (9 of them fail
if the fix is reverted): the whole CLASS — `for` / `while` / `for-of`
effect-only loops, sequential and nested ones, every-iteration-runs and
no-over-run checks, a structural check that the in-loop comparison
survives into the compiled script, the reduced ownership guard (missing
ref input, unsigned holder, second name unchecked), plus the
`find`-destructure symptom.

Please re-run the on-devnet adversarial test to confirm end-to-end. NOTE:
`bench-aiken.ts` currently cannot validate this — with the sources as of
07-25 18:25 the `edit`, `claim` and `ownership init` scenarios FAIL for
both implementations (Aiken fails 5 of 7), identically before and after
this fix.

### Original report

Found by an on-devnet adversarial test (2026-07-25). The masterpiece
`LeafNode.edit` ownership guard (`src/masterpiece.pebble` ~L286):

```
for( let n = 0; n < nRects; n++ ) {
    const nm = rectName( refRects.head() );
    const Some{ value: refIn } = tx.refInputs.find( i =>
        i.resolved.value.amountOf( ownershipHash, nm ) == 1 );   // <-- returns None
    const PubKey{ hash: holderPkh } = refIn.resolved.address.payment;
    assert tx.requiredSigners.includes( holderPkh );
    refRects = refRects.tail();
}
```

is supposed to reject an edit unless the tx references, for EVERY `ownerRect`,
a reference input holding that deed whose pub-key holder signed. It does not.

**Repro (ledger ACCEPTS a tx that must fail):** claim `(0,0)-(2,2)`, then edit
leaf 0 with redeemer `ownerRects = [(3,3)-(5,5)]` (a rect the signer holds NO
deed for), referencing only the `(0,0)-(2,2)` deed, signing with its holder,
and changing pixel `(3,3)` (inside the *claimed* rect, so the "unchanged
outside owned rects" row-gap check passes). `cardano-cli transaction submit`
succeeds on the devnet node (phase-2 passes) — i.e. **you can overwrite any
pixels on the canvas without owning them.**

**Impact:** the deed-ownership requirement for edits is fully bypassable →
anyone can edit anyone's plot. buildooor's build-time eval also does NOT reject
it (it *does* reject the row-gap violation in the sibling case), so it slipped
past local checks too.

**Diagnosis:** `find` returns `None` (no ref input matches `nm`), but
`const Some{ value: refIn } = None` does not fail — control reaches
`refIn.resolved.…` / the `requiredSigners.includes` assert without trapping and
the guard passes. So `const Some{…} = <None>` is NOT the refutable, fail-on-
no-match binding the sources rely on (this pattern is used the same way in
`ownership.pebble` `claim`, so those paths may be equally affected). Needs
UPLC-level diagnosis of the `find` builtin lowering + the `Some` extractor on a
`None` value. NOT fixing here (compiler is a separate agent's remit); the
sibling row-gap check (`slice ==`) works, so only the option-destructure of a
`find` miss is implicated. Pinpointing whether ANY ref input / signature is
needed (vs. a wrong one) is a pending granular probe.

## FIXED — BUG 11 (compile crash) and BUG 12 (cross-arm extractor miscompilation)

Both confirmed FIXED in the local builds of 2026-07-22 (pebble + plutus-machine >3.0.3)
and verified on-devnet: the full `ownership.pebble` — 4 mint methods, state, all
bodies — now passes node-side phase-2 on a real init tx (previously
`force tailList []`). Kept for the record:

- **BUG 11**: custom (negative-tag) natives survived to the forcing pass
  (`getNRequiredForces ... input was: -N`) — fixed by re-running native lowering in
  the letted/hoisted drain loop of `compileIRToUPLC`.
- **BUG 12**: per-arm redeemer field extractors hoisted OUT of their `Case` dispatch
  branch ran in every arm (`force headList []` node-side; local evaluators silently
  passed — see the plutus-machine error-swallowing fix, >3.0.3). Fixed by stopping
  the letted-placement climb at `Case`-branch boundaries…
- **BUG 12b (found while verifying; fixed locally in this session)**: …but the
  boundary stop can never trigger when the SAME extractor is referenced from TWO
  different arms (e.g. `split`'s and `merge`'s field-0/1 extractors are identical
  terms): the refs' LCA sits at/above the dispatch, and the binding still ran in
  every arm. Fixed in `handleLetted/index.ts`: when every reference reaches the LCA
  by crossing into a `Case` branch and more than one branch is involved, the letted
  is DUPLICATED per branch (each copy wrapped at its branch root). o2-variant
  (init+free+split+merge) verified on-devnet after the fix.

## BUG 13 — stale parent pointers make `ensureProperlyForcedBuiltins` wrap a detached tree (FIXED locally, 2026-07-22)

First `masterpiece.pebble` init evaluation (never reached before BUG 12 was fixed)
failed with `builtin tailList expected at least 1 forces, got 0`: the compiled output
contained `[(λ f body) (builtin tailList)]` bindings — shared forced-native letted
values — where the binding value NEVER got its `force` wrapper, while all use sites
apply `f` bare. Root cause: the ensure pass replaces nodes through `node.parent`, and
the shared native instance's parent pointer was stale (pointing into a tree fragment
detached by earlier passes), so the `IRForced` wrap landed in the detached copy.
**Fix**: `sanifyTree( root )` at the top of
`ensureProperlyForcedBuiltinsAndReturnRoot` (clones any child whose parent pointer
disagrees, making every parent trustworthy). Note the family resemblance to the
stale-work-stack bug already fixed in `rewriteNativesAppliedToConstantsAndReturnRoot`
— parent-pointer hygiene may deserve a systematic audit.

## BUG 14 — redundant `IRForced` over shared forced-native bindings double-forces (FIXED locally, 2026-07-22)

Exposed immediately by the BUG 13 fix: with the binding now correctly pre-forced,
an ALIAS letted of shape `IRForced( IRLetted( tailList ) )` compiles to `(force f)`
— forcing the already-forced shared value — and fails with
`cannot force builtin tailList that has already received all its arguments`.
The IR mixes two conventions (uses-carry-the-force vs binding-is-pre-forced).
**Fix**: normalization sweep at the top of `handleLettedAndReturnRoot` stripping any
`IRForced` whose transitive child (through `IRLetted`/`IRHoisted`) is a forced-tag
`IRNative` — an `IRNative` already denotes the ready-to-apply function; concrete
UPLC forces are materialized only by the ensure pass at builtin occurrences.

## BUG 15 — `equalsData :: not data` in masterpiece init (RESOLVED 2026-07-23)

Resolved by the fixing agent's compiler build of 2026-07-23 together with a corrected
OFF-CHAIN parameter ABI: scalar `param`s (`bytes`, `int`) must be applied as NATIVE
UPLC constants (`UPLCConst.byteString` / `UPLCConst.int`), NOT wrapped in Data — a
Data-wrapped scalar param miscompiles "at a distance" (the validator uses it as its
native type). Data-encoded types (Address, TxOutRef, structs) still apply as data.
See `offchain/contracts.mjs` `applyParams`. Worth a docs section: the parameter ABI
was undocumented and cost a full debugging cycle.

## BUG 16 — `const` in lambdas lost compute-once (FIXED in local build 2026-07-23 02:13)

**Semantics (author):** a `const` computes ONCE at declaration (UPLC let-binding);
lambdas access it as a plain variable — `filter( o => o.address == ownAddr )` is the
idiomatic form. Lambda access to a mutable `let` is invalid (compile-error diagnostic
still pending — see below).

**The bug:** the compiler inlined a const's defining expression into closure bodies,
re-evaluating per invocation: `masterpiece.pebble` init's
`every( c => c == initialCid )` re-ran sha256-of-8KB 128x → 58.8B CPU steps
(`ExUnitsTooBigUTxO`, 10B limit); even multi-referenced consts re-evaluated
(~48M x 128). Loops compile to recursive lambdas — same defect.

**VERIFIED FIXED** (build 02:13): the restored `every`-check measures 3.64B total vs
27.0B on the previous build — the check itself now costs ~0.3B. The genesis-honesty
check is back in `masterpiece.pebble` init; the head/tail list walks in
`ipfs.pebble` are kept regardless (cheaper than `[i]` indexing at any size).

**Diagnostic LANDED (verified 2026-07-23, local build 04:35):** lambda access
to a mutable `let` now fails compilation with
`ERROR 30207: "Lambdas can only capture 'const' bindings; 'n' is a mutable
'let'. Copy it into a 'const' before the lambda."` — nothing pending here.

## BUG 17 — single-state datum ABI: spend dispatch and `as Contract` cast disagree (RESOLVED 2026-07-23 — doc bug, not a compiler bug)

**RESOLUTION:** dispatch and the `as Ownership` cast **agree** — both decode the
WRAPPED form `Constr 0 [ coords ]` — on 0.3.6 and on the local compiler alike,
verified by execution tests driving both paths with the same datum
(`compiler.masterpieceBugs.0_3_6.singleStateAbi.test.ts` pins the ABI).

What actually happened: `State.md` incorrectly documented the single-state datum
as bare fields (`shortcutSingleConstructor`); the observed `unIData :: not a data
integer` came from casting the state datum `as Coordinates` (the FIELD struct)
rather than `as Ownership` / `as Ownership.Free`. The doc is fixed (wrapped
`Constr 0 [fields]`, with a caution that nested struct fields are themselves
Constr-wrapped).

Consequences for this repo:
- The dummy `state Unused` workaround is **unnecessary** — a single-state
  contract is internally consistent; off-chain the Free datum is
  `Constr 0 [ Constr 0 [x0,y0,x1,y1] ]` (exactly what the workaround produced
  anyway, since the wrapped single-state and first-of-multi-state encodings
  coincide).
- Free functions needing the union cast: `export contract` + importing the
  contract type (0.3.7 `redeemerof`/contract-export feature) makes
  `od as Ownership` available outside method bodies.

For a contract with exactly ONE `state` (Ownership's `Free { coords: Coordinates }`):

- the SPEND dispatch decodes the datum as the WRAPPED record `Constr 0 [ coords ]`
  (bare coords datum → `unConstrData :: not a data constructor, data "0"` — it
  unConstrs the first int field);
- the `as Ownership` union cast (and the docs' `shortcutSingleConstructor`
  description in `State.md`) decode the BARE record (wrapped datum →
  `unIData :: not a data integer`).

The same datum cannot satisfy both, making any single-state contract that inspects
its own continuing datums internally inconsistent. Also: the `as Contract` union
cast only resolves inside contract methods — a free function using it fails with
`'Ownership' is not defined` (fine as a scoping rule, but it forces datum decodes
into method bodies).

**Contract-side workaround applied**: a dummy second state (`state Unused`, no spend
methods) forces the explicit multi-state encoding (`Constr` per state, in declaration
order), which dispatch and casts agree on — verified by the full e2e. Off-chain, the
Free datum is `Constr 0 [ Constr 0 [x0,y0,x1,y1] ]`.

## BUG 18 — `Value` equality / `contains` unusable on mint values with burns (FIXED locally, 2026-07-23)

Native `Value` equality is lowered as bidirectional `valueContains`
(`IRNative/index.ts:311` — "Native Value: equality via bidirectional
valueContains"), and the `valueContains` BUILTIN is specified to fail on any
negative quantity ("valueContains :: negative quantity in first value").
`tx.mint` legitimately carries negative quantities for burns, so **any
exact-mint check of a burning tx errors at runtime** — there is currently no
Pebble-native way to compare a mint value that includes a burn.

Repro (hit on preprod, deployed ownership contract `03ac47b3…`): the
`Free.claim` path where the claim covers the whole free rect mints
`{ deed: +1, marker: -1 }`; `valueEq( tx.mint, expected )` (defined as
`a.contains(b) && b.contains(a)`) fails with
`valueContains :: negative quantity in first value`. Failing ScriptContext
data captured in `offchain/probe-claim-exact.ts` (evaluates the DEPLOYED
script against the captured context; run with `CTX=<hexfile>`). The same
applies to `mint split` / `mint merge` (both always burn).

Not a miscompile — the builtin semantics are per spec. But since builtin
`Value`s are canonically normalized (sorted, no zero entries; `insertCoin`
with qty 0 deletes), `equalsData( valueData a, valueData b )` is a total,
order-independent exact equality that handles negatives. Suggestion: lower
`Value ==` that way (or expose it, and document that
`contains`/`valueEq`-style checks must never see burns).

Contract-side workaround used here: `valueEq` reimplemented as
`a.toData() == b.toData()`.

**RESOLUTION (compiler build of 2026-07-23):** the suggestion was adopted
verbatim — `Value ==` is now lowered as `equalsData( valueData a, valueData b )`
instead of bidirectional `valueContains`: total, order-independent, exact
(builtin Values are canonically normalized), and burn-safe. Verified by
execution tests reproducing the exact reported error on the old lowering
(`valueContains :: negative quantity in first value`) and passing on the new
one (`compiler.masterpieceBugs.0_3_7.valueEq.test.ts`). The `a.toData() ==
b.toData()` workaround is now equivalent to plain `a == b` and revertible.
`contains` keeps its per-spec semantics (fails on negatives) — use `==` for
exact-mint checks of burning txs.

## BUG 19 — plutus-machine masks the real error when a `case` scrutinee is an error value (FIXED, machine 3.0.5, 2026-07-23)

`Machine/Machine.js:386`: when a `case` scrutinee evaluates to a `CEKError`
(CEKValueTag 5), the frame handler falls into the default branch and reports
`case: expected constr or constant value, got 5` instead of propagating the
underlying error. Only errors coming out of `constantToUntaggedConstr` are
propagated. Effect: buildooor's build-time eval reported the useless
"got 5" message for the BUG 18 failure; the real
`valueContains :: negative quantity…` message only surfaced when evaluating
the script directly with `Machine.evalSimple`. Fix: in the `case` frame, if
`value.tag === CEKValueTag.Error`, return that error as the result.

**RESOLUTION:** fixed exactly as suggested in `@harmoniclabs/plutus-machine`
**3.0.5** (regression test: `caseErrorScrutinee.test.ts` — a failing-builtin
scrutinee keeps its own message). The 3.0.5 dist is installed in BOTH this
repo's `offchain/node_modules` (which was still on 3.0.3 — buildooor's
build-time eval now reports real errors AND halts on any CEK error, per the
3.0.4 fix it was also missing) and the pebble compiler's `node_modules`.

## BUG 20 — bare fallback `spend` unreachable for ill-formed datums (FIXED locally, 2026-07-23)

`State.md` documents that a bare contract-level `spend` "runs when the script
is invoked with a datum that doesn't match any declared state's constructor,
OR with no datum at all". Only the no-datum case works. With states present,
the compiled datum dispatch is a bare `case` over the state constructors and
an ill-formed datum CRASHES instead of falling back:

- datum `Constr 4 [I 42]` (unknown tag)  → `case: constructor tag 4 out of
  range (2 branches)` — the dispatch `case` has one branch per state and no
  default arm routing to the fallback;
- datum `I 42` (not a constructor)       → `unConstrData :: not a data
  constructor` — the decode itself is not guarded;
- no datum                                → fallback runs correctly.

Repro: `src/marketplace.pebble` (2 states + bare `spend recover() {}`) probed
via `offchain/probe-marketplace.ts` + `offchain` fallback variants; minimal
contract:

    contract T3 {
        state A { v: int; spend a1() { assert 1 == 2; } spend a2() { assert 1 == 2; } }
        state B { w: int; spend b1() { assert 1 == 2; } spend b2() { assert 1 == 2; } }
        spend f() { assert 5 == 6; }
    }

spending with datum `Constr 5 [I 1]` must reach `f` (reject with ITS error),
but errors with `case: constructor tag 5 out of range` before dispatch.
Expected fix: emit the datum dispatch with a default arm (and guard the
`unConstrData`) so both ill-formed cases route to the bare `spend`.

Consequence here: marketplace UTxOs with ill-formed CONSTR datums are stuck
(not recoverable) until fixed; datum-less ones recover fine.

**RESOLUTION (compiler build of 2026-07-23):** the datum dispatch is now
emitted defensively, as suggested: `chooseData` guards that the datum is a
constructor at all, and the tag is range-checked against the declared states
BEFORE the decode — both ill-formed shapes (`Constr N` with unknown tag, and
non-constructor data) route to the bare `spend` fallback; well-formed state
datums dispatch exactly as before. Verified with the reporter's minimal T3
contract via execution tests (`compiler.masterpieceBugs.0_3_7.datumFallback.test.ts`)
and with THIS repo's `probe-marketplace.ts` — the "recover (unknown-constr
datum)" scenario now ACCEPTS (the probe's pinned-bug expectation was flipped
to `expectOk`; all 11 scenarios pass). Ill-formed-datum marketplace UTxOs are
recoverable after recompiling/redeploying.

NOT a bug (self-inflicted, noting to avoid re-confusion): `TxBuilder.build()`
is async — forgetting `await` makes every build "succeed" and validator
failures surface later as unhandled rejections. Probe/test code must
`await txb.build(...)`.

## BUG 21 — prelude types not usable in cast position (`as TxOutRef` → "'TxOutRef' is not defined") (FIXED locally, 2026-07-23)

Prelude struct types resolve fine in TYPE position (`param genesisUtxo:
TxOutRef;` works, field access `spendingRef.id` works) but are NOT in scope
in cast position:

    const InlineDatum{ datum: tagData } = payOut.datum;
    const t = tagData as TxOutRef;
    // ERROR 256: "'TxOutRef' is not defined"   (marketplace.pebble:58:27)

User-defined structs in the same file cast fine (`tagData as RefTag`), so
the cast machinery works — the prelude names just aren't registered in
whatever scope `as` resolves against. Expected: any type valid in type
position is valid in cast position.

Related gap hit while looking for alternatives: values of struct types have
no `.toData()` (`spendingRef.toData()` → ERROR 2339 "Property 'toData' does
not exist on type 'TxOutRef'"), so there is also no way to compare a typed
value against raw `data` without a cast — making the missing cast the only
route, hence the workaround below.

Workaround used in `src/marketplace.pebble`: declare a data-shape twin
struct in user code and cast to that instead:

    struct RefTag { id: bytes; index: int; }   // Constr 0 [ id, index ]
    const RefTag{ id: tagId, index: tagIndex } = tagData as RefTag;
    assert tagId == spendingRef.id && tagIndex == spendingRef.index;

**RESOLUTION (compiler build of 2026-07-23):** the cast path required the SOP
variant of the resolved type to exist before even considering the data
variant — data-only prelude structs (TxOutRef, Address, ...) register a SOP
name that is never added to the program's types, so the cast errored
"not defined" while type position worked. The cast now accepts whichever
variant exists. `tagData as TxOutRef` / `as Address` compile and decode
correctly (execution tests: `compiler.masterpieceBugs.0_3_7.preludeCast.test.ts`);
the `RefTag` twin-struct workaround is unnecessary. The `.toData()` gap on
prelude struct values is unchanged (tracked as a stdlib gap, not part of this
fix).

## BUG 22 — repeated input-value access + output find corrupts a field extraction (FIXED locally, 2026-07-23)

`unConstrData :: not a data constructor` — with the DATA being an OUTPUT's
VALUE map — when a spend method combines ALL of:

1. a `tx.inputs.find(...)` result whose `.resolved.value` is used TWICE as
   inline expressions (e.g. once in an `amountOf` assert, once more in any
   later expression: `==`, `.toData()`, `.lovelaces()` — the comparison form
   is irrelevant);
2. a `tx.outputs.find( o => o.address == ownAddr )` where `ownAddr` came
   from that input;
3. a use of the found output's `.value`.

Removing any one ingredient makes it pass, and the same statements compile
correctly in smaller contracts (single-method, no outputs find), so this is
a code-shape-dependent letted/extractor placement bug (same family as
BUG 12b): some shared field-extractor binding ends up applied to the wrong
subject — the unConstrData receives outputs[0]'s value map where a
constr-shaped node was expected.

Minimal repro: `bug-repros/bug22-minimal.pebble` (2-state contract, one
method; eval with datum `Constr 0 [I 1]`, redeemer `Constr 0 []`, one input
+ one output at the same address). Real-world hit: `Listing.partialBuy` in
`src/marketplace.pebble`, exercised by `offchain/probe-marketplace.ts`.

**Workaround (verified):** const-bind the value ONCE and reuse the binding —
`const inValue = inp.resolved.value;` (and `const relistedValue =
relisted.value;`) — every probe scenario passes with the bindings in place.
The marketplace source carries a NOTE at the binding site; remove it when
this is fixed.

**RESOLUTION (compiler build of 2026-07-23):** not a letted/extractor placement
bug — an SSA-rename corruption in expressify's destructure lowering, upstream
of all IR passes. `flattenSopNamedDeconstructInplace...` registered the
pattern's rename keyed by the STRUCT FIELD NAME for user patterns: two
`const Some{ value: X } = ...` destructures in the same method chained
`value -> inp`, then `value -> out1` — and the SSA chain-remap propagated
`inp -> out1`, so every LATER access to `inp` silently compiled as `out1`
(the dumped TIR literally contained `case out1 is TxIn{...}`). The datum was
the output's value map because the TxIn extractor chain ran on the TxOut.
Field-name keying is only correct for SYNTHESIZED patterns (loop-state
threading); all user-pattern call sites (const-destructure statements, match
statement arms) now key the rename by the binding's own name — the flag and
warning comment already existed from an earlier fix of the same family
(case EXPRESSIONS passed `false`; statements did not).

**Downstream verification (reporter, 2026-07-23, dist build 14:18):**
`bug-repros/bug22-minimal.pebble` now evaluates to ACCEPT; the const-binding
workaround has been REMOVED from `src/marketplace.pebble` (back to the inline
exact-value relist check), and the compiled output is byte-identical to the
const-bound form (same policy `703d2fcf…`) — the rename no longer leaks. All
19 `offchain/probe-marketplace.ts` scenarios pass, and all three contracts
compile clean on this build.
Verified: the minimal repro accepts (execution tests
`compiler.masterpieceBugs.0_3_7.valueExtract.test.ts`, exact tx-shape context);
the const-bind workaround has been REVERTED in `src/marketplace.pebble`
(inline double-use restored) and all 19 marketplace probe scenarios pass,
including the composed split+partialBuy.

NOTE: any 0.3.7-built contract whose method destructures the SAME
constructor twice (`Some{ value: ... }` twice, etc.) and reads the first
binding after the second destructure was MISCOMPILED — recompile with the
fixed build and compare script hashes.

## BUG 23 — rewriting one method's body miscompiles a DIFFERENT method (FIXED locally, 2026-07-23)

Simplifying `RootNft.commit` from the multi-leaf sentinel/merge-join shape to
a plain single-leaf walk made `mint init` — untouched code — fail its local
eval AND node phase-2 with `headList :: empty list passed to 'head'`.
Reverting ONLY the commit body (identical init source both times) makes init
pass again at the same budget (3.62B), so the commit rewrite corrupts init's
compilation at a distance. Same cross-method placement family as BUG 12b/22.

The failing commit body differs from the working one by NOT using
`List<int>`/`List<bytes>` lets and `.prepend` (it compares `j == lidx`
directly). Removing the last list-building code from commit evidently changes
how list helpers shared with `init`/`wholeImageCidOf` are hoisted or letted,
and one of init's list walks ends up applied to an empty list.

Repro: `bug-repros/bug23-plain-commit-masterpiece.pebble` (compiles OK;
evaluating `mint init` via `offchain/probe-mpinit.ts` fails headList).
Baseline: current `src/masterpiece.pebble` — identical except commit keeps
the sentinel-terminated list shape — init passes.

**Workaround (in the source):** the single-leaf commit keeps the original
list/sentinel formulation with exactly one prepended entry; a NOTE in
`commit` marks it for simplification once fixed.

**RESOLUTION (compiler build of 2026-07-23, FINAL after BUG 25): one real
bug, one reverted over-fix.** The root cause is **the single-reference
placement path ignoring dispatch boundaries**: a redeemer-field extractor
referenced ONCE inside a method's loop takes a placement path (single-ref
under recursive) that climbed to where its free vars are defined WITHOUT
the `Case`-branch stop the multi-ref climb has — the whole extractor chain
for commit's redeemer escaped ABOVE the purpose dispatch and ran on EVERY
arm (`unListData :: not a data list` on init; visible in the final IR:
`RootNftRedeemer`/`LeafNodeRedeemer` field extractors bound above the
`Mint_policy` binding). The climb now stops at case-branch edges like
every other placement path (the BUG 12 family guard, applied to the one
path that lacked it). The `headList :: empty list` facet came from the
SAME escapes: escaped bindings nested across compile rounds and captured
each other's references through their shared hash-derived binder symbols
(the failing build had 6 nested shadowed binders, `tx` shadowed 3x); with
the escape fixed the nesting no longer arises. A per-binding-site
fresh-symbol scheme initially shipped as a second layer of defense was
REVERTED — it regressed previously verified compilation (see BUG 25).

Verified: the repro (`bug-repros/bug23-plain-commit-masterpiece.pebble`)
passes `probe-mpinit` at 3.62B; the **commit simplification has been
APPLIED** to `src/masterpiece.pebble` (plain `j == lidx` walk, sentinel
lists removed) and init still passes (4.17B; all three contracts compile,
marketplace probe 25/25). Regression tests:
`compiler.masterpieceBugs.0_3_7.branchEscape.test.ts` (minimal two-method
contract: a state-spend method's single-use List extractor in a loop must
not run on a mint method's arm — reproduces `unListData :: not a data
list` pre-fix).

## BUG 24 — const-chain in `every`-lambda loses compute-once again (FIXED locally, 2026-07-23)

With a DEEPER const chain the compute-once guarantee breaks again:

    const half = std.builtins.replicateByte( CHUNK_SIZE / 2, 255 );
    const initialChunk = std.bytes.concat( half, half );
    const initialCid = cidV1Raw( initialChunk );          // sha256 of 14336B
    assert ext.leafsCids.every( c => c == initialCid );   // 73 elements

`initialCid` is recomputed PER ELEMENT: masterpiece init measured 25.8B CPU
(vs 10B limit); capturing a cheap const instead
(`const firstCid = ext.leafsCids.head(); assert firstCid == initialCid;
every( c => c == firstCid )`) drops it to 4.31B. The single-level chain
(`initialChunk` directly from replicateByte) was verified compute-once after
the BUG 16 fix; the extra const hop (or the concat expression) re-triggers
inlining into the closure.

**RESOLUTION (compiler build of 2026-07-23):** the culprit is the DIVISION,
not the chain depth: `CHUNK_SIZE / 2` lowers to `divideInteger`, which the
compute-once totality check could neither prove total (division can fail on
zero) nor evaluate at compile time — so `replicateByte( CHUNK_SIZE / 2, 255 )`
and everything derived from it was deemed unsafe to float and stayed in the
closure. Integer `/`, quotient, `%` and remainder by a comptime NON-ZERO
constant are now comptime-evaluable and total, so the whole chain floats and
hashes once. Pinned by a budget-ratio test with this exact shape
(`compiler.masterpieceBugs.0_3_6.constFloat.test.ts`: ratio ~4.0 pre-fix →
~1.0). The cheap-const capture workaround is unnecessary.

## BUG 25 — compiler dist 20:35 REGRESSION: previously on-chain-verified masterpiece fails hatch (FIXED locally, 2026-07-23)

The masterpiece source that passed FULL devnet e2e on-chain this afternoon
(single-leaf commit run, txs 871f301f…/46cd7313…/b9c7ccf4…, compiled with
dist 14:18) now fails `Nursery.hatch` with
`headList :: empty list passed to 'head'` when compiled with dist 20:35 —
byte-identical source, same devnet, same offchain code. `mint init` passes;
the first hatch tx fails its spend eval. Captured failing ScriptContext:
`bug-repros/bug25-hatch-ctx.hex` (from a 73-leaf variant run; the 128-leaf
verified source fails identically).

Observed while attempting the 1024x1022 / 73x14-row leaf geometry (parked in
`next-geometry/` — see its README): that work surfaced a stream of
value/shape-sensitive failures on this and the 14:18 build (init failing
`unListData` in one run and passing the next with identical code and only
different param VALUES/input ordering; hatch headList under every code
formulation tried, including with the state declaration order swapped).
Those observations are probably all facets of this instability; re-test the
parked geometry once hatch compiles correctly again.

Genuine non-compiler findings from the same session (documented in
next-geometry/README): `replicateByte` caps its length at 8192 bytes, so a
14336-byte chunk must be assembled from two halves; and BUG 24 above.

**RESOLUTION (compiler build of 2026-07-23, later):** bisected to the
per-binding-site fresh-symbol scheme that shipped in dist 20:35 as part of
the BUG 23 fix — with it, hatch failed `headList :: empty list`; without it
(keeping only the case-branch placement guard) the FULL devnet e2e passes:
init, both hatches, claim, edit — the exact scenario that regressed. The
fresh-symbol scheme has been REVERTED; the branch guard alone fixes both
BUG 23 symptoms (see the amended BUG 23 resolution). Re-verified end to
end with the final build: e2e ALL STEPS PASSED, `probe:mpinit` 3.62B,
marketplace probe 25/25. The parked 73-leaf geometry is worth re-testing
on this build — BUG 24's division fix also lands here, so the
two-half-chunk `initialCid` chain is compute-once again.

## Downstream verification of BUGs 23/24/25 fixes (2026-07-23, dist 20:57)

All three verified from this project after the fixing agent's rebuild:

- **BUG 25**: the 128x8 canary e2e passed fully on devnet, then the parked
  1024x1022 / 73x14 geometry went green across ALL suites: protocol e2e,
  marketplace e2e (11 steps incl. carve partial-buy, split, merge), and
  HATCH_ALL (all 73 leaves hatched incl. the final nursery-exhaustion hatch,
  then claim/edit/commit on the fully-hatched canvas).
- **BUG 24**: the plain two-level const chain
  (`half -> concat -> cidV1Raw` captured in `every`) now measures **2.26B**
  for masterpiece init (was 25.8B recomputing; even the firstCid workaround
  measured 4.31B on the old build) — compute-once restored and improved. The
  workaround has been REMOVED from the source.
- **BUG 23**: the plain `j == lidx` single-leaf commit walk (the formulation
  that used to miscompile init at a distance) is now the live source and
  passed on-chain commit; the sentinel-shape workaround is REMOVED.

Geometry outcome (now the live source): 73 leaves x 14 rows (14336B chunks),
canvas 1024x1022. Single-leaf commit at this geometry measures **2.66B**
(was 4.20B at 128 leaves). `next-geometry/` has been merged into `src/` and
deleted. Preprod still runs the previous 128x8 deployment; the website is
unchanged (preprod-compatible) until a redeploy is requested.

## Independent downstream verification of BUGs 18–21 (2026-07-23, local build 04:35 / machine dist 04:19)

Re-verified from this project (the reporter), independently of the fixer's
own tests:

- **BUG 18** — minimal contract `assert tx.mint == tx.mint.scale(1)` evaluated
  with mint `{policy: {"" : -1}}`: ACCEPT (and with `+1`: ACCEPT) — `Value ==`
  is burn-safe now. (Project contracts keep the equivalent
  `a.toData() == b.toData()` since they are already deployed with it.)
- **BUG 19** — `case CEKValueTag.Error` propagation branch present in local
  plutus-machine source AND dist. NOTE: this project's `offchain/` and
  `website/` node_modules still resolve published plutus-machine 3.0.3 —
  builder error messages stay masked here until a release lands.
- **BUG 20** — marketplace probe (11 scenarios) green: unknown-constr datum
  AND non-constr datum (`I 42`) both reach the bare `spend recover`; no-datum
  still works; state dispatch unchanged.
- **BUG 21** — `tagData as TxOutRef` + `const TxOutRef{ id, index }`
  destructure now compiles; the `RefTag` twin-struct workaround has been
  REMOVED from `src/marketplace.pebble` (policy with direct cast:
  `80bee0a4…`, all probe scenarios pass).
- **BUG 16 leftover** — the lambda/non-`const` compile diagnostic landed
  (`ERROR 30207`), see the updated note in BUG 16.

## Doc / stdlib gaps (not crashes) — re-verified on 0.3.6

- **`mempty` does not exist.** `Prelude/Value.mdx` says to build values from `mempty`;
  nothing by that name (or `emptyValue`) is defined. Workaround for an empty `Value`:
  `someValue.scale( 0 )` (e.g. `tx.mint.scale( 0 )`) — containment-based comparisons are
  insensitive to any zero entries it may keep.
- **`None` is not an expression.** For an empty `Optional` field (e.g. `stake`), the
  literal is `undefined`. `None`, `None{}`, `Optional.None` all fail to resolve.
  (`Some{ value: x }` works as a *pattern*, as documented.)
- **`LinearMapEntry` fields are `key`/`value`, not `fst`/`snd`** as
  `Prelude/LinearMap.mdx` documents (`ERROR 2339` on `.fst`); supported form is
  destructuring: `const { key, value } = m.head();`.
- **`TxIn` field is `ref`, not `txOutRef`** (docs `API/types/Tx/TxIn.md`).
- **Spend context field is `spendingRef`**, not `spendingInputRef` as in
  `Contract Statements.md`.
- **Struct construction needs the qualified form** `Type.Constructor{ ... }`; for a
  single-constructor struct that's `Coordinates.Coordinates{ ... }` — a bare
  `Coordinates{ ... }` fails with `'Coordinates' is not defined`.
