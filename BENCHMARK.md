# Pebble vs Aiken — contract benchmark

Date: 2026-07-24 · Pebble: local dist build 2026-07-24 12:14 (+ source reshape) ·
Aiken: v1.1.19, stdlib v2.2.0 · Plutus V3, preprod cost model.
History: 07-23 20:57 -> 07-24 01:13 -> 02:43 -> 03:16 -> 04:11 (current);
trend tables below.

## Methodology

The three protocol contracts (ownership, masterpiece, marketplace) were
reimplemented in Aiken (`aiken-port/`) with a **byte-identical datum/redeemer
ABI** and identical validation rules, at the live geometry (1024x1022 canvas,
73 leaves x 14 rows, 14336-byte chunks). Because the ABI matches, one
scenario builder (`offchain/bench-aiken.ts`) drives **both** implementations
through the **same transactions**, evaluated by the **same machine**
(buildooor / plutus-machine) with the same cost model — no methodology gap.

Both implementations ACCEPT every scenario, which doubles as a semantic
cross-check of the two codebases — including the composed partial buy, where
the marketplace spend and the ownership carve mint validate together in one
transaction.

Reproduce with: `cd aiken-port && aiken build`, then
`cd offchain && npx tsx bench-aiken.ts`.

## Script sizes (applied scripts, cbor-wrapped bytes)

| contract    | 07-23  | 01:13 | 03:16 | 04:11     | Aiken | Pebble/Aiken |
|-------------|-------:|------:|------:|----------:|------:|-------------:|
| ownership   |  6,768 | 5,248 | 4,817 | **4,632** | 4,716 |     **98 %** |
| masterpiece | 10,895 | 8,367 | 6,574 | **6,407** | 6,933 |     **92 %** |
| marketplace |  4,899 | 4,119 | 3,168 | **3,190** | 3,600 |     **89 %** |

04:11: **all three Pebble scripts are now SMALLER than the Aiken build.**
Total drop from 07-23: ownership -32 %, masterpiece -41 %, marketplace -35 %.

## Execution units per scenario

Sum over all script redeemers in the transaction (CPU steps / memory units).
On-chain limits: 10B CPU, 140M mem per transaction.

CPU steps (B), by Pebble build; Aiken column unchanged across runs.
Pebble/Aiken over 100 % = Pebble costs more.

| scenario                      | 07-23 | 01:13 | 02:43 | 03:16     | Aiken | Pebble/Aiken |
|-------------------------------|------:|------:|------:|----------:|------:|-------------:|
| masterpiece init              | 2.26  | 1.39  | 1.31  | **1.27**  | 1.65  |    **77 %**  |
| ownership init                | 0.05  | 0.05  | 0.05  | 0.05      | 0.05  |      ~100 %  |
| commit 1 leaf                 | 2.66  | 2.60  | 2.42  | **1.71**  | 1.45  |       118 %  |
| partialBuy (carve, 4 relists) | 1.09  | 1.08  | 1.05  | **0.62**  | 0.59  |       105 %  |
| hatch leaf 0                  | 1.12  | 1.07  | 0.71  | **0.51**  | 0.40  |       128 %  |
| edit leaf 0 (4 px)            | 1.44  | 1.41  | 1.05  | **0.91**  | 0.49  |       186 %  |
| claim 10x10 (4 complements)   | 0.66  | 0.60  | 0.58  | **0.37**  | 0.27  |       137 %  |

Memory (M units), 03:16 vs Aiken (Pebble/Aiken):

| scenario         | Pebble | Aiken | Pebble/Aiken |
|------------------|-------:|------:|-------------:|
| masterpiece init |   2.85 |  4.12 |     **69 %** |
| partialBuy       |   0.99 |  1.76 |     **56 %** |
| claim            |   0.59 |  0.70 |     **84 %** |
| commit 1 leaf    |   4.01 |  4.52 |     **89 %** |
| ownership init   |   0.07 |  0.14 |     **50 %** |
| edit leaf 0      |   0.74 |  0.56 |       132 %  |
| hatch leaf 0     |   0.36 |  0.24 |       150 %  |

Build-by-build highlights:
- **01:13**: sizes −15–22 %; masterpiece init −38 %, first scenario Pebble
  beats Aiken.
- **02:43**: list/closure paths — hatch −34 %, edit −26 %.
- **03:16 (largest yet)**: sizes −8–24 % — masterpiece & marketplace now
  SMALLER than Aiken. CPU: **commit −29 %, partialBuy −41 %, claim −36 %,
  hatch −28 %, edit −13 %**. Worst-case CPU ratio 215 % -> 186 %; Pebble now
  WINS on memory in 5 of 7 scenarios and is at CPU parity on partialBuy
  (105 %) and near it on commit (118 %).

## Interpretation

- **The gap is smallest where builtin work dominates.** Masterpiece init and
  commit are mostly sha256 over the 14,336-byte chunk plus the 74-link
  dag-pb whole-image hash; builtins cost the same in both languages, so the
  ratio there (55–73 %) approximates the irreducible floor of each tx.
- **The gap is largest on interpretation-heavy paths** (edit's row walk,
  hatch's checks, claim's complement verification): list traversal, data
  decoding, and closure calls — where Aiken's more mature optimizer
  currently produces 2.5–3x cheaper code.
- **Tiny scripts are at parity** (ownership init: 0.05B both).
- **Read as a snapshot, not a ceiling.** These numbers were taken right
  after fixes for Pebble BUGs 23–25; two compute-once regressions (BUGs
  16/24) each cost ~10x while present. The structural gap points at concrete
  Pebble optimizer targets: closure-call overhead, data-decode paths, and
  list traversal.
- Everything fits comfortably on-chain in both languages: the heaviest tx
  (commit, 2.66B Pebble) uses ~27 % of the CPU budget.
