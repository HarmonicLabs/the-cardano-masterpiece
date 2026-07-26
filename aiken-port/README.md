# Aiken port — benchmark comparison with Pebble

A faithful reimplementation of the three protocol contracts (plus the Lock
parking contract) in Aiken v1.1.19 / stdlib v2.2.0, Plutus V3, at the live
geometry (1024x1022 canvas, 73 leaves x 14 rows, 14336-byte chunks).

**Same ABI by construction**: identical datum/redeemer constr layouts, token
names, and validation rules — so the benchmark drives BOTH implementations
through the *same transactions* with the *same evaluator* (buildooor /
plutus-machine, preprod cost model). The production code in `src/` is
untouched; this folder exists purely for comparison.

Run: `aiken check && aiken build` here, then
`cd ../offchain && npx tsx bench-aiken.ts`.

## Results (2026-07-23, pebble local dist 20:57 vs aiken v1.1.19)

Applied script sizes (cbor-wrapped bytes):

| contract    | Pebble | Aiken | ratio |
|-------------|-------:|------:|------:|
| ownership   |  6,768 | 4,716 |  70 % |
| masterpiece | 10,895 | 6,933 |  64 % |
| marketplace |  4,899 | 3,600 |  73 % |

Ex-units, sum over all redeemers of the scenario tx (CPU steps / mem units):

| scenario                      | Pebble         | Aiken          | Aiken CPU |
|-------------------------------|----------------|----------------|----------:|
| masterpiece init              | 2.26B / 5.26M  | 1.65B / 4.12M  |      73 % |
| hatch leaf 0                  | 1.12B / 0.71M  | 0.40B / 0.24M  |      36 % |
| commit 1 leaf                 | 2.66B / 5.92M  | 1.45B / 4.52M  |      55 % |
| edit leaf 0 (4 px)            | 1.44B / 1.16M  | 0.49B / 0.56M  |      34 % |
| claim 10x10 (4 complements)   | 0.66B / 1.17M  | 0.27B / 0.70M  |      41 % |
| partialBuy (carve, 4 relists) | 1.09B / 1.88M  | 0.59B / 1.76M  |      54 % |
| ownership init                | 0.05B / 0.08M  | 0.05B / 0.14M  |     ~100 % |

Notes:

- Both implementations ACCEPT every scenario — the ports agree on semantics
  for all measured paths, including the composed partialBuy (marketplace
  spend + ownership carve mint in one tx).
- The dominant costs (init/commit) are the whole-image dag-pb CID over 74
  links plus sha256 of the 14336-byte chunk; those builtin costs are
  identical, which is why the ratio is mildest there (~55–73%) — the gap is
  the surrounding interpretation overhead (data decoding, list traversal,
  closure calling), where Aiken's more mature optimizer currently wins.
- The tiny ownership init is at parity: it is almost all builtin work.
- Pebble caveats: numbers taken right after compiler fixes for BUGs 23–25;
  the Pebble optimizer is visibly younger (BUG 16/24 were compute-once
  regressions costing 10x when present) and the gap should be read as
  "today's snapshot", not a language ceiling.
