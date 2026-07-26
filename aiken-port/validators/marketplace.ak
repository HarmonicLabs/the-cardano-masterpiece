//// Marketplace — secondary market for ownership deed NFTs.
//// Mirror of src/marketplace.pebble (same ABI, carve-based partial buys,
//// checkless recover fallback for ill-formed datums).

use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{lovelace_of, quantity_of}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use masterpiece/rect.{Coordinates, is_valid_rect, rect_area, rect_contains, rect_name}
use ownership.{complements}

pub const min_listing_lovelace: Int = 2_000_000

/// ABI: Listing = Constr 0 [seller, pricePerPixel], Request = Constr 1 [requester, coords]
pub type MarketDatum {
  Listing { seller: Address, price_per_pixel: Int }
  Request { requester: Address, coords: Coordinates }
}

/// Listing spends: buy = 0, partialBuy = 1, cancel = 2
pub type ListingRedeemer {
  Buy { rect: Coordinates }
  PartialBuy { parent: Coordinates, bought: Coordinates }
  CancelListing
}

/// Request spends: fill = 0, cancel = 1
pub type RequestRedeemer {
  Fill
  CancelRequest
}

fn single_script_input(tx: Transaction, own_addr: Address) -> Bool {
  list.count(tx.inputs, fn(i) { i.output.address == own_addr }) == 1
}

/// the seller payment, pinned to THIS listing by its own utxo ref as datum
fn paid_with_tag(
  tx: Transaction,
  seller: Address,
  min_lovelace: Int,
  oref: OutputReference,
) -> Bool {
  expect Some(pay_out) = list.find(tx.outputs, fn(o) { o.address == seller })
  expect lovelace_of(pay_out.value) >= min_lovelace
  expect InlineDatum(tag) = pay_out.datum
  expect tag_ref: OutputReference = tag
  tag_ref == oref
}

fn signed_by_holder(tx: Transaction, owner: Address) -> Bool {
  expect VerificationKey(pkh) = owner.payment_credential
  list.has(tx.extra_signatories, pkh)
}

/// every complement relisted on the SAME terms, one output per complement,
/// in carve's fixed order; returns the leftover outputs (must be none)
fn check_relists(
  outs: List<Output>,
  comps: List<Coordinates>,
  seller: Address,
  ppp: Int,
  policy: ByteArray,
) -> Bool {
  when comps is {
    [] -> outs == []
    [c, ..cs] ->
      when outs is {
        [] -> False
        [o, ..os] -> {
          expect InlineDatum(d) = o.datum
          expect Listing { seller: s2, price_per_pixel: p2 }: MarketDatum = d
          expect s2 == seller && p2 == ppp
          expect quantity_of(o.value, policy, rect_name(c)) == 1
          expect lovelace_of(o.value) >= min_listing_lovelace
          check_relists(os, cs, seller, ppp, policy)
        }
      }
  }
}

validator marketplace(collection_policy: ByteArray) {
  spend(
    datum: Option<Data>,
    redeemer: Data,
    oref: OutputReference,
    tx: Transaction,
  ) {
    when datum is {
      // no datum: value nobody can be refunded to — anyone may sweep
      None -> True
      Some(raw) ->
        if raw is md: MarketDatum {
          expect Some(own_in) =
            list.find(tx.inputs, fn(i) { i.output_reference == oref })
          let own_addr = own_in.output.address
          when md is {
            Listing { seller, price_per_pixel } -> {
              expect lr: ListingRedeemer = redeemer
              when lr is {
                Buy { rect } -> {
                  expect single_script_input(tx, own_addr)
                  expect
                    quantity_of(own_in.output.value, collection_policy, rect_name(rect)) == 1
                  paid_with_tag(
                    tx,
                    seller,
                    price_per_pixel * rect_area(rect),
                    oref,
                  )
                }
                PartialBuy { parent, bought } -> {
                  expect single_script_input(tx, own_addr)
                  expect
                    quantity_of(
                      own_in.output.value,
                      collection_policy,
                      rect_name(parent),
                    ) == 1
                  // pin WHICH carve runs (the ownership policy enforces the
                  // exact mint and the cut geometry)
                  expect
                    quantity_of(tx.mint, collection_policy, rect_name(parent)) == -1
                  expect
                    quantity_of(tx.mint, collection_policy, rect_name(bought)) == 1
                  let comps = complements(parent, bought)
                  expect list.length(comps) >= 1
                  let relist_outs =
                    list.filter(tx.outputs, fn(o) { o.address == own_addr })
                  expect
                    check_relists(
                      relist_outs,
                      comps,
                      seller,
                      price_per_pixel,
                      collection_policy,
                    )
                  paid_with_tag(
                    tx,
                    seller,
                    price_per_pixel * rect_area(bought),
                    oref,
                  )
                }
                CancelListing -> signed_by_holder(tx, seller)
              }
            }
            Request { requester, coords } -> {
              expect rr: RequestRedeemer = redeemer
              when rr is {
                Fill -> {
                  expect single_script_input(tx, own_addr)
                  // the requested deed reaches the requester
                  expect Some(_) =
                    list.find(
                      tx.outputs,
                      fn(o) {
                        o.address == requester && quantity_of(
                          o.value,
                          collection_policy,
                          rect_name(coords),
                        ) == 1
                      },
                    )
                  True
                }
                CancelRequest -> signed_by_holder(tx, requester)
              }
            }
          }
        } else {
          // ill-formed datum: recover
          True
        }
    }
  }

  else(_) {
    fail
  }
}
