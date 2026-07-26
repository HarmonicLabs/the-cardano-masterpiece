//// Ownership — 2D land registry. Mirror of src/ownership.pebble
//// (same datum/redeemer ABI, same 1008x1008 canvas, same tiling invariant).

use aiken/collection/list
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, from_asset, lovelace_of, merge, quantity_of}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use masterpiece/rect.{
  Coordinates, canvas_height, canvas_width, is_valid_rect,
  rect_area, rect_contains, rect_name, same_rect,
}

pub const lovelace_per_pixel: Int = 5_000_000

pub const free_token_name: ByteArray = ""

/// ABI: Free = Constr 0 [ Constr 0 [x0,y0,x1,y1] ], Unused = Constr 1 [ int ]
pub type OwnershipDatum {
  Free { coords: Coordinates }
  Unused { unused: Int }
}

/// mint methods in declaration order: init=0, free=1, merge=2, carve=3
/// (split removed — the 1-complement case of carve)
pub type OwnershipMint {
  MintInit { genesis_idx: Int }
  MintFreeForward
  MintMerge { a: Coordinates, b: Coordinates }
  MintCarve { parent: Coordinates, target: Coordinates }
}

/// Free spend: claim = Constr 0 [coords]
pub type FreeRedeemer {
  Claim { claimed: Coordinates }
}

fn own_address(policy: PolicyId) -> Address {
  Address { payment_credential: Script(policy), stake_credential: None }
}

fn is_free_node_value(o: Output, own_addr: Address, policy: PolicyId) -> Bool {
  o.address == own_addr && quantity_of(o.value, policy, free_token_name) == 1
}

/// the ≤4 guillotine complements of `target` in `parent`, fixed order
/// top, bottom, left, right (same scheme as Free.claim / carve)
pub fn complements(parent: Coordinates, target: Coordinates) -> List<Coordinates> {
  let bot =
    if target.y1 < parent.y1 {
      [Coordinates { x0: parent.x0, y0: target.y1, x1: parent.x1, y1: parent.y1 }]
    } else {
      []
    }
  let lft =
    if parent.x0 < target.x0 {
      [Coordinates { x0: parent.x0, y0: target.y0, x1: target.x0, y1: target.y1 }]
    } else {
      []
    }
  let rgt =
    if target.x1 < parent.x1 {
      [Coordinates { x0: target.x1, y0: target.y0, x1: parent.x1, y1: target.y1 }]
    } else {
      []
    }
  let rest = list.concat(bot, list.concat(lft, rgt))
  if parent.y0 < target.y0 {
    [Coordinates { x0: parent.x0, y0: parent.y0, x1: parent.x1, y1: target.y0 }, ..rest]
  } else {
    rest
  }
}

/// every continuing free node carries the marker + the validator-computed
/// complement coords, in order; returns how many were consumed
fn check_free_outs(
  outs: List<Output>,
  comps: List<Coordinates>,
  own_addr: Address,
  policy: PolicyId,
) -> Bool {
  when comps is {
    [] -> outs == []
    [c, ..cs] ->
      when outs is {
        [] -> False
        [o, ..os] -> {
          expect is_free_node_value(o, own_addr, policy)
          expect InlineDatum(d) = o.datum
          expect Free { coords }: OwnershipDatum = d
          expect same_rect(coords, c)
          check_free_outs(os, cs, own_addr, policy)
        }
      }
  }
}

validator ownership(protocol_owner: Address, genesis_utxo: OutputReference) {
  mint(redeemer: OwnershipMint, policy: PolicyId, tx: Transaction) {
    when redeemer is {
      // one-shot genesis: mint exactly 1 FREE marker over the whole canvas
      MintInit { genesis_idx } -> {
        expect Some(genesis_in) = list.at(tx.inputs, genesis_idx)
        expect genesis_in.output_reference == genesis_utxo
        expect tx.mint == from_asset(policy, free_token_name, 1)
        let own_addr = own_address(policy)
        expect Some(free_out) =
          list.find(
            tx.outputs,
            fn(o) { quantity_of(o.value, policy, free_token_name) == 1 },
          )
        expect is_free_node_value(free_out, own_addr, policy)
        expect InlineDatum(d) = free_out.datum
        expect Free { coords }: OwnershipDatum = d
        same_rect(
          coords,
          Coordinates { x0: 0, y0: 0, x1: canvas_width, y1: canvas_height },
        )
      }
      // forwarder: a genuine Free node is being spent; its validator rules
      MintFreeForward ->
        list.any(
          tx.inputs,
          fn(i) {
            i.output.address == own_address(policy) && quantity_of(
              i.output.value,
              policy,
              free_token_name,
            ) == 1
          },
        )
      MintMerge { a, b } -> {
        let side_by_side = a.x1 == b.x0 && a.y0 == b.y0 && a.y1 == b.y1
        let stacked = a.y1 == b.y0 && a.x0 == b.x0 && a.x1 == b.x1
        expect side_by_side || stacked
        let union = Coordinates { x0: a.x0, y0: a.y0, x1: b.x1, y1: b.y1 }
        tx.mint == merge(
          from_asset(policy, rect_name(a), -1),
          merge(
            from_asset(policy, rect_name(b), -1),
            from_asset(policy, rect_name(union), 1),
          ),
        )
      }
      // burn parent, mint target + its validator-computed complements
      MintCarve { parent, target } -> {
        expect is_valid_rect(target)
        expect rect_contains(parent, target)
        let comps = complements(parent, target)
        expect list.length(comps) >= 1
        let expected =
          list.foldl(
            comps,
            merge(
              from_asset(policy, rect_name(parent), -1),
              from_asset(policy, rect_name(target), 1),
            ),
            fn(c, acc) { merge(acc, from_asset(policy, rect_name(c), 1)) },
          )
        tx.mint == expected
      }
    }
  }

  spend(
    datum: Option<Data>,
    redeemer: FreeRedeemer,
    oref: OutputReference,
    tx: Transaction,
  ) {
    // only Free nodes are spendable (Unused = unspendable, as in Pebble)
    expect Some(raw) = datum
    expect Free { coords }: OwnershipDatum = raw
    let Claim { claimed } = redeemer
    expect Some(own_in) = list.find(tx.inputs, fn(i) { i.output_reference == oref })
    let own_addr = own_in.output.address
    expect Script(policy) = own_addr.payment_credential
    // genuine marker + exactly one script input
    expect quantity_of(own_in.output.value, policy, free_token_name) == 1
    expect
      list.count(tx.inputs, fn(i) { i.output.address == own_addr }) == 1
    // pixels not taken
    expect is_valid_rect(claimed)
    expect rect_contains(coords, claimed)
    // pay the protocol
    expect Some(pay_out) =
      list.find(tx.outputs, fn(o) { o.address == protocol_owner })
    expect lovelace_of(pay_out.value) >= rect_area(claimed) * lovelace_per_pixel
    // continuing free nodes: exactly the non-empty guillotine complements
    let comps = complements(coords, claimed)
    let k = list.length(comps)
    let free_outs = list.filter(tx.outputs, fn(o) { o.address == own_addr })
    expect check_free_outs(free_outs, comps, own_addr, policy)
    // exact mint: the OwnerNft plus the marker delta (k-1 may be -1 for a
    // whole-node claim, or 0 when exactly one complement continues)
    let deed_mint = from_asset(policy, rect_name(claimed), 1)
    let expected =
      if k == 1 {
        deed_mint
      } else {
        merge(deed_mint, from_asset(policy, free_token_name, k - 1))
      }
    tx.mint == expected
  }

  else(_) {
    fail
  }
}
