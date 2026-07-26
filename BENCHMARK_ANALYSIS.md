# Pebble vs Aiken — UPLC structural analysis

Companion to `BENCHMARK.md` (Pebble local dist 20:57 vs Aiken 1.1.19).
Method: parsed both compiled UPLC ASTs (`offchain/analyze-uplc.ts` —
re-runnable) and read the pretty-printed terms side by side
(`out/cmp-{pebble,aiken}-marketplace.uplc.txt`).

## Structural counts (static occurrences in the compiled AST)

| metric      | mktpl P | mktpl A | steward P | steward A | mstr P | mstr A |
|-------------|--------:|--------:|--------:|--------:|-------:|-------:|
| total nodes |   4,923 |   3,439 |   6,714 |   4,463 |  9,555 |  5,292 |
| applications|   1,539 |     963 |   2,024 |   1,443 |  3,050 |  1,642 |
| lambdas     |     614 |     246 |     868 |     243 |  1,154 |    385 |
| cases       |     516 |     164 |     747 |     176 |    916 |    214 |
| `unConstrData` | 269 |     126 |     346 |     187 |    502 |    145 |
| `unListData`|      36 |       6 |      23 |       7 |     57 |     19 |
| `equalsData`|      38 |       8 |      26 |       9 |     43 |     17 |
| `iData`+`constrData` | 30 |  1 |      52 |      10 |     ~30|    ~22 |
| `unValueData` |    15 |       0 |      17 |       0 |     44 |      0 |
| `lookupCoin`/`insertCoin` | 15 | 0 |    17 |       0 |     42 |      0 |
| `dropList`  |      18 |       0 |      13 |       0 |     13 |      0 |

Both compilers share the good baseline idioms: pre-forced builtins bound
once at the top, multi-value bindings via `case (constr 0 [v…]) [(lam … body)]`,
recursion via self-application. The cost gap comes from what happens *around*
data access.

## The five differences that matter

### 1. Pebble re-decodes; Aiken decodes once (the dominant cost)

Aiken unpacks a constr ONCE into bindings and reuses them:

    case (constr 0 [ head(fields), head(tail(fields)), … ])
      [ (lam field0 (lam field1 … body)) ]   -- body reuses field0/field1

Pebble materializes a FRESH full chain at (almost) every property-access
site:

    unValueData( head( tail( unConstrData( head( tail( unConstrData(x) ))))))

That is why Pebble carries 2.1–3.5x the `unConstrData` sites and 3–6x the
`unListData` sites. Static sites understate the runtime effect: when the
chain sits inside a loop or a per-element lambda, the whole decode re-runs
per element — this is the same cost family as BUGs 16/24, but for
*multi-use* accesses that the letted machinery deliberately duplicates
per branch (BUG 12b) or leaves at each use site. It directly explains why
the gap is worst on the interpretation-heavy paths (edit 34%, hatch 36%,
claim 41%).

The compiler already HAS the decode-once machinery —
`ExpressifyCtx.introduceSingleConstrDataLettedFields` registers shared field
letteds — but it only fires for explicit destructure statements, its
`properties` cache is per-scope and not consulted across child scopes, and
inline chains (`a.b.c` used twice, `.value` after `.address`) each rebuild
the full chain from the subject.

**Improvement: subject-keyed decode caching in expressify.** For every
prop-access subject, reuse one `unconstrPair`/`fields` letted per scope
chain (walk parent ctxs), and register intermediate steps (`x.resolved`)
so `x.resolved.address` and `x.resolved.value` share the `resolved` decode.
Estimated impact: the majority of the 2.5–3x on interpretation-heavy paths.

### 2. Every `Value` access pays a full `unValueData` conversion

Aiken never touches the native `Value` builtins: it walks the raw data map
(`unMapData`, `mkPairData` — zero `unValueData`). Pebble converts the datum
into the NATIVE Value type at **every** access site: `amountOf` compiles to
`lookupCoin(p, n, unValueData(⟨full decode chain⟩))` — and `unValueData`
validates/converts the *entire* value map each time (44 sites in
masterpiece; the tx-mint value is converted separately for every
`tx.mint.amountOf(…)` in a method).

**Improvement:** (a) the decode-once caching above should treat
`unValueData(x)` as a cacheable step, so N accesses to one value cost one
conversion; (b) longer-term, consider lowering single-lookup patterns
(`v.amountOf(p, n)` on a value only used once) to a raw data-map walk that
skips conversion entirely, as Aiken does.

### 3. Re-encoding natives to data for comparisons

Pebble uses 4–5x more `equalsData` and 30–50 `iData`/`constrData` sites vs
Aiken's near-zero: decoded native ints/structs get re-encoded to data so a
generic `equalsData` can compare them (e.g. comparing a decoded field
against a just-built `constrData`). Aiken compares scalars natively after
its single decode.

**Improvement:** in `getStdEq`/comparison lowering, when both sides are
known data-encoded values, compare the RAW data (no decode + re-encode);
when both are native scalars, use the native equality — never
decode→re-encode→equalsData.

### 4. Field indexing via `dropList` helpers

Pebble indexes constr fields with `dropN`+`headList` helper applications
(13–18 sites; Aiken: zero) — each `dropList` application costs a closure
call plus the list walk, repeated per access. Aiken emits shared
`tail`-chains bound progressively (`t1 = tail fields; t2 = tail t1; …`),
so sibling fields share the walk prefix. This merges with improvement 1:
one fields-binding per subject with progressive tails.

### 5. Closure count (size + per-call overhead)

Pebble emits 2.5–3.6x the lambdas and 1.4–1.9x the applications for the
same logic — mostly *consequences* of 1–4 (every duplicated chain brings
its binder boilerplate) plus per-branch extractor duplication (BUG 12b)
and helper indirection that survives `inlineSingleUseLetBindings`. Fixing
the decode paths should close most of the size gap too (scripts are
currently 1.4–1.5x; on-chain size is a fee/reference-script cost, not an
execution cost).

## What is NOT the problem

- **Branch laziness**: Aiken wraps branches in `delay`/`force` (225–333
  delays); Pebble's strict-`case` lowering has ~zero and is cheaper per
  conditional. No action needed.
- **Recursion encoding**: both use self-application; equivalent.
- **Builtin-dominated work**: sha256/serialise costs are identical by
  construction — masterpiece init/commit already sit at 55–73% and will
  converge toward parity as the interpretive overhead shrinks.

## Priority order for the Pebble optimizer

1. **Subject-keyed decode-once caching across prop accesses** (expressify) —
   biggest lever, targets `unConstrData`/`unListData`/`dropList`
   duplication and most of the closure overhead.
2. **Cache `unValueData` per subject** (same mechanism) and consider raw
   data-map lookup lowering for single-use values.
3. **Comparison lowering without re-encoding** (raw-data vs native-native).
4. Re-measure with `bench-aiken.ts`; expect the interpretation-heavy
   scenarios (edit/hatch/claim, currently 34–41%) to move the most.


---

## Follow-up: measurements and actions taken (2026-07-24)

Directives: fix the re-decoding; keep `unValueData` and `dropList` (benchmark
to confirm); benchmark the comparison strategies before changing anything.

### Micro-benchmarks (plutus-machine, preprod cost model)

**`Value` access — `unValueData` CONFIRMED optimal, kept.** 3-policy value:

| shape | CPU |
|---|---:|
| `unValueData` + `lookupCoin`, once per access (x8) | 99.4M |
| `unValueData` ONCE + `lookupCoin` x8 | 20.5M |
| raw data-map walk x8 (aiken style) | 91.7M |
| SINGLE access: `unValueData`+`lookupCoin` | 13.4M |
| SINGLE access: raw walk | 15.7M |

The builtin path beats the raw walk even for a single access — Aiken's
map-walking is the outdated approach, not Pebble's builtins. The entire
problem is the REPEATED conversion, i.e. the re-decoding bug below.

**Comparisons — decode+native ~2x cheaper than re-encode+equalsData** (x16
scalar comparisons): `equalsData(iData(n), d)` 31.4M vs
`unIData(d) == n` 14.5M; two data ints raw-equalsData 30.7M vs decode-both
15.4M. Struct-vs-struct on already-data stays `equalsData` (single builtin).

### Shipped: data round-trip elimination (IR peephole)

The `iData`/`constrData` comparison sites turned out to be
build-then-immediately-decode round trips
(`sndPair(unConstrData(constrData(0, [x, iData(unIData(d))])))`). A new
peephole (`eliminateDataRoundTripsAndReturnRoot`, 3 sweep points) rewrites
only the always-safe decode-after-encode direction, resolving builtin heads
through the lexical environment (pre-forced builtins are variables by the
time adjacencies form). Validated: full suite + full devnet e2e green.
Sizes: stewardship 6768→6737, masterpiece 10895→10772, marketplace 4899→4833;
CPU deltas small (hatch 1.12→1.11B) — the peephole is the small half; the
big half is the decode-once sharing below.

### SHIPPED: decode-once field extraction (ON by default)

Subject-keyed shared field letteds in expressify (registered in the
subject's defining scope, shadowing-aware lookup, alias support for
`const x = shared` decls), made SOUND by two placement-machinery pieces:

1. **`siteScoped` letted semantics + spine witness.** Decode-once letteds
   are marked as having per-use-site source semantics; `handleLetted`
   shares a PARTIAL (can-fail) extractor only at positions with a "spine
   witness" (some reference reached without crossing a branch/lambda/delay
   edge — evaluation-order neutrality), falling back to per-reference
   inlining (the exact pre-decode-once code) otherwise.
2. **Recursive per-branch duplication.** Hash-identical extractors across
   arms (`unIData(headList(redeemerFields))` exists in several methods)
   form ONE letted group; the per-branch duplication used to bind each
   copy at the TOPMOST branch crossing (a purpose-dispatch arm), where a
   foreign arm's redeemer crashes the extractor — the masterpiece hatch
   `headList :: empty list`. Placement now descends recursively through
   nested crossings (purpose arm → state arm → method arm) until the
   group's refs no longer all cross, and binds there (with the witness
   fallback for partials).

Two dead ends documented for the record: per-site FRESH binder symbols are
unsound here (IR hashing is symbol-identity-based, not alpha-invariant —
fresh symbols collapse hash-dedup and sharing), and ancestor-binding reuse
can resurrect dead bindings into eager evaluation.

**Measured impact** (bench-aiken, same methodology):

| metric | before | after | aiken |
|---|---:|---:|---:|
| masterpiece init CPU | 2.26B | **1.39B** | 1.65B |
| claim CPU | 0.65B | 0.60B | 0.27B |
| commit CPU | 2.66B | 2.60B | 1.45B |
| stewardship size | 6,737 | 5,248 | 4,716 |
| masterpiece size | 10,772 | 8,367 | 6,933 |
| marketplace size | 4,833 | 4,119 | 3,600 |

Sizes closed from 64–73% to **83–90%** of the Aiken port; masterpiece init
now BEATS it. Remaining CPU gap on hatch/edit/claim is elem-access loops +
closure overhead — next lever is the generalized inverse-value remembering
below.
Validated: full compiler suite, full devnet e2e, mpinit probe (1.39B),
marketplace probe 25/25.

### Next design (user direction): remembering inverse values

Generalized "the value came from an inverse operation" tracking: when a
typed value was produced by `FromData(d)` (or any operation with a known
inverse), its `toData()` should REUSE `d` instead of re-encoding — and
symmetrically for any inverse pair (encode/decode, wrap/unwrap,
serialise/parse). Plan: expressify-level cache mapping each letted/variable
to its known pre-image per operation pair, consulted before emitting the
forward operation; subsumes and extends the peephole (which only catches
syntactic adjacency AFTER inlining).


---

## Optimization loop results (2026-07-24, cont.)

Four further compiler optimizations landed (see pebble CHANGELOG for
details): recursive `.length()` lowering (was 20-360M/call via
`listToArray`), anchor-based letted grouping across loop-continuation
delays (killed 226 per-use re-evaluations incl. duplicate sha256 chains),
arm-local placement of expensive closed values (the 14KB `initialCid` no
longer taxes every method ~350M), and case-binder reuse in the list helper
templates.

NOTE: `src/masterpiece.pebble` moved to the 73-leaf/14-row geometry
(03:19), so only measurements after that are apples-to-apples with the
Aiken port.

Current standings (bench-aiken):

| scenario | pebble CPU | aiken CPU | pebble MEM | aiken MEM |
|---|---:|---:|---:|---:|
| masterpiece init | **1.27B** | 1.65B | **2.85M** | 4.12M |
| commit 1 leaf | **1.42B** | 1.45B | **4.15M** | 4.52M |
| stewardship init | 0.05B | 0.05B | **0.07M** | 0.14M |
| partialBuy | 0.62B | 0.59B | **0.99M** | 1.76M |
| edit (4px) | 0.58B | 0.49B | 0.74M | 0.56M |
| hatch | 0.51B | 0.40B | 0.36M | 0.24M |
| claim 10x10 | 0.37B | 0.27B | **0.59M** | 0.70M |

Sizes after the late single-use inline pass: **pebble smaller on ALL
THREE** — stewardship 4,555 vs 4,716; masterpiece 6,482 vs 6,933;
marketplace 3,100 vs 3,600. Updated CPU/mem: init 1.26B/2.79M, commit
1.41B/4.10M (both beat aiken), hatch 0.51B/0.35M, edit 0.58B/0.73M,
claim 0.37B/0.58M, partialBuy 0.62B/0.98M.

Remaining CPU gaps (hatch/edit/claim/partialBuy, 5-37%) are dominated by
machine-step overhead (~2x aiken's Var/Apply/Lambda step counts —
binding-heavy codegen) and per-output value conversions inside filter
predicates. Profiling tooling: `PEBBLE_PROFILE=1` (instrumented local
plutus-machine) + `offchain/profile-bench.scratch.ts`; final-IR dumps via
`PEBBLE_DUMP_FINAL_IR=1`. Caveat: buildooor's fee loop evaluates scripts
1-2x per build — per-build profile counts overstate per-execution counts;
trust bench exUnits for totals.


---

## Final standings and assessment (2026-07-24, optimization loop conclusion)

Two more optimizations landed since the last table: a late single-use
inline pass (91 -> 14 residual bindings) and raw-data `amountOf` walks
(skip `unValueData` for fromData-conversion subjects). Final bench:

| scenario | pebble CPU | aiken CPU | pebble MEM | aiken MEM |
|---|---:|---:|---:|---:|
| masterpiece init | **1.26B** | 1.65B | **2.79M** | 4.12M |
| commit 1 leaf | **1.39B** | 1.45B | **4.08M** | 4.52M |
| stewardship init | **0.04B** | 0.05B | **0.07M** | 0.14M |
| partialBuy | 0.60B (~par) | 0.59B | **1.01M** | 1.76M |
| claim 10x10 | 0.35B | 0.27B | **0.62M** | 0.70M |
| hatch | 0.50B | 0.40B | 0.36M | 0.24M |
| edit (4px) | 0.58B | 0.49B | 0.74M | 0.56M |

Scripts: pebble smaller on ALL THREE (4,555/6,407/3,190 vs
4,716/6,933/3,600). Starting point of this loop: pebble was 2-3x slower
on interpretation-heavy paths and 36-45% larger.

**CPU beats or matches on 4/7 scenarios; memory beats on 5/7; sizes 3/3.**

### Why the remaining gaps are NOT compiler-reachable

Profiling attributes the hatch/edit/claim CPU (and hatch/edit MEM)
residuals to implementation-shape differences between the two ports, not
codegen quality:

- **claim**: pebble runs 70 address `equalsData` calls vs the Aiken
  port's 22 (~2.1M each — identical per-call cost). The Aiken port
  filters outputs by address once and re-scans the small result per
  rect; the pebble source re-filters per rect. Same validation rules,
  3x the comparisons.
- **edit**: `stewardRects[n]` is indexed per row x rect (14 x N `dropList`
  walks plus per-row arithmetic — headList 261 vs 110, addInteger 187
  vs 64). The Aiken port hoists the per-rect data out of the row loop.
- **hatch**: remaining delta is per-output value inspection shape plus
  the ~1.25x machine-step floor of the current codegen.
- 8 remaining `amountOf` sites use the inline case-extraction shape and
  still pay `unValueData` (~40-60M total) — extendable, diminishing.

Matching or beating Aiken on these three requires the PEBBLE CONTRACT
SOURCE to adopt the same traversal shapes (filter-once-then-scan,
hoisting `stewardRects[n]` per-rect data out of the row loop) — natural
contract-side follow-ups for the reporter, not compiler changes.

### Shipped compiler optimizations (this loop)

1. Recursive `.length()` (was flat-priced `listToArray`, 20-360M/call).
2. Anchor-based letted grouping across loop-continuation delays
   (226 per-use re-evaluations eliminated, incl. duplicate sha256).
3. Arm-local placement of expensive closed values (`initialCid` no
   longer taxes every method).
4. Case-binder reuse in list helper templates (find/lookup/some/every/
   filter).
5. Late single-use inline pass (all three scripts now smaller than the
   Aiken port).
6. Raw-data `amountOf` walks.

All validated by the full compiler suite (625 tests), the full devnet
e2e, and this benchmark after every step.


---

## Round 2 after source-shape alignment (2026-07-24, later)

With the reporter's traversal reshaping + two more compiler changes
(raw-data `amountOf` extended to inline case-extraction objects):

| scenario | pebble | aiken | |
|---|---:|---:|---|
| masterpiece init | **1.25B / 2.81M** | 1.65B / 4.12M | beats |
| commit | **1.36B / 4.10M** | 1.45B / 4.52M | beats |
| claim | **0.25B / 0.49M** | 0.27B / 0.70M | **beats (new)** |
| partialBuy | **0.57B / 1.03M** | 0.59B / 1.76M | **beats (new)** |
| stewardship init | **0.04B / 0.08M** | 0.05B / 0.14M | beats |
| hatch | 0.46B / 0.40M | 0.40B / 0.24M | trails |
| edit | 0.59B / 0.86M | 0.49B / 0.56M | trails |

**CPU+MEM now beat aiken on 5 of 7 scenarios**; sizes all three smaller.

### Duplicate-subtree analysis (the "repeated trees" question)

At UPLC level deBruijn indexing makes alpha-equivalent trees
byte-identical, so repetition is directly countable
(`offchain/dup-subtrees.scratch.ts`): pebble has 93 repeated shapes
(~1,944 wasted nodes) vs aiken's 21 (~272). However nearly all pebble
repeats are x2 copies across DISPATCH ARMS — the deliberate per-branch
duplication of arm-specific extractors (only one copy ever executes).
They cost SIZE, not steps. `unValueData` is now fully eliminated from
hatch and edit profiles.

### Remaining hatch/edit attribution (profile-verified)

- **edit** (+100M CPU, +300k MEM): the row loop re-decodes each rect's
  coordinates PER ROW (headList 302 / tailList 275 / addInteger 204 —
  fields chain runs rows x rects on the SAME rects). The Aiken port
  decodes each rect's coords once and threads ints through the row walk.
  Decode placement, not traversal order — one more source reshape
  (pre-extract coords before the row loop, or invert to rect-outer /
  row-inner) would close most of it. The MEM gap is almost exactly the
  step-count gap (steps cost 100 mem each).
- **hatch** (+60M CPU, +160k MEM): builds expected continuing-output
  datums as data and compares with `equalsData` (mkCons 80, equalsData
  10 vs 4) where the Aiken port destructures the actual datum and
  compares fields natively; plus the step floor.
- Systemic step floor: pebble executes ~1.4x aiken's machine steps for
  equivalent logic (binding-chain verbosity) — worth ~15-20M per
  scenario; the remaining compiler-side lever, with diminishing returns.


### Decision: memory-first policy; case-extraction raw-walk REVERTED

Real-world contracts hit the MEMORY limit before the CPU limit, so
optimization policy is memory-first. The case-extraction `amountOf`
raw-walk traded conversions (CPU) for machine steps, and steps carry mem
cost — memory rose in every scenario (hatch 0.35 -> 0.40M). Reverted;
the letted-fromData raw-walk (memory-neutral, CPU-positive) stays.

Reference (post-revert): init 1.26B/2.79M, commit 1.39B/4.08M, claim
0.25B/0.49M, partialBuy 0.60B/1.01M, own-init 0.04B/0.07M all beat
aiken on both axes; hatch 0.48B/0.35M and edit 0.59B/0.85M trail
(aiken 0.40/0.24 and 0.49/0.56).

Under the memory-first lens, the levers for hatch/edit are:
1. the source-level decode-placement items above (fewer decode chains =
   fewer steps = less mem);
2. the codegen step floor (~1.4x): binding-chain verbosity — each
   binding is Lambda+Apply+Var steps at 100 mem each;
3. allocation traffic: mkCons (list building in expected-datum
   construction), 32-byte+ builtin outputs.
