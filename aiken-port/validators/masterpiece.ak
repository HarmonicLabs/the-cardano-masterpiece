//// Masterpiece — the on-chain collaborative 1008x1008 image/bmp.
//// Mirror of src/masterpiece.pebble (84 leaves x 12 rows, single-leaf commit).

use aiken/builtin
use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, from_asset, merge, quantity_of}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use masterpiece/ipfs.{cid_to_ipfs_uri, cid_v1_raw, whole_image_cid}
use masterpiece/rect.{Coordinates, rect_name}

pub const n_leafs: Int = 84

pub const line_length: Int = 1008

pub const rows_per_leaf: Int = 12

pub const chunk_size: Int = 12096

pub const leaf_nft_name: ByteArray = ""

// CIP-67 labeled names, body "masterpiece"
pub const root_ref_nft_name: ByteArray = #"000643b06d61737465727069656365"

pub const root_user_nft_name: ByteArray = #"000de1406d61737465727069656365"

const metadata_name_key: ByteArray = "name"

const metadata_image_key: ByteArray = "image"

const metadata_media_type_key: ByteArray = "mediaType"

const root_display_name: ByteArray = "The Cardano Masterpiece"

const media_type_bmp: ByteArray = "image/bmp"

pub type RootState {
  leafs_cids: List<ByteArray>,
  raw_cid: ByteArray,
}

/// ABI: RootNft = Constr 0, LeafNode = Constr 1, Nursery = Constr 2
pub type MasterpieceDatum {
  RootNft { metadata: Pairs<ByteArray, ByteArray>, version: Int, extra: RootState }
  LeafNode { idx: Int, raw_cid: ByteArray, chunk: ByteArray }
  Nursery { next_idx: Int }
}

pub type MintRedeemer {
  MpInit { genesis_idx: Int }
}

/// per-state spend redeemers (cast from Data per datum variant, as in Pebble)
pub type CommitRedeemer {
  Commit { ref_idx: Int }
}

pub type EditRedeemer {
  Edit { owner_rects: List<Coordinates> }
}

/// replicateByte caps at 8192 bytes: assemble the 12096-byte all-white chunk
pub fn initial_chunk() -> ByteArray {
  let half = builtin.replicate_byte(chunk_size / 2, 255)
  builtin.append_bytearray(half, half)
}

/// whole-image CID over [ header, leaf chunks... ] as one flat dag-pb node
pub fn whole_image_cid_of(header: ByteArray, leafs_cids: List<ByteArray>) -> ByteArray {
  let header_len = builtin.length_of_bytearray(header)
  let sizes = [header_len, ..list.repeat(chunk_size, n_leafs)]
  whole_image_cid(
    [cid_v1_raw(header), ..leafs_cids],
    sizes,
    header_len + n_leafs * chunk_size,
    sizes,
  )
}

fn own_address(policy: PolicyId) -> Address {
  Address { payment_credential: Script(policy), stake_credential: None }
}

/// new CID list = old list with position `lidx` replaced by `lcid`
fn check_cid_update(
  old: List<ByteArray>,
  new: List<ByteArray>,
  j: Int,
  lidx: Int,
  lcid: ByteArray,
) -> Bool {
  when new is {
    [] -> old == [] && j == n_leafs
    [nc, ..ns] ->
      when old is {
        [] -> False
        [oc, ..os] -> {
          expect
            nc == (
              if j == lidx {
                lcid
              } else {
                oc
              }
            )
          check_cid_update(os, ns, j + 1, lidx, lcid)
        }
      }
  }
}

fn slice_eq(a: ByteArray, b: ByteArray, off: Int, len: Int) -> Bool {
  builtin.slice_bytearray(off, len, a) == builtin.slice_bytearray(off, len, b)
}

/// one row of the unchanged-outside-owned-rects walk: rects covering the row
/// (in x0 order, cursor-monotonic) delimit the must-be-equal gaps
fn check_row_gaps(
  old: ByteArray,
  new: ByteArray,
  row_off: Int,
  y: Int,
  rects: List<Coordinates>,
  cursor: Int,
) -> Bool {
  when rects is {
    [] -> slice_eq(old, new, row_off + cursor, line_length - cursor)
    [rc, ..rest] -> {
      let covers = rc.y0 <= y && y < rc.y1
      let gap_end =
        if covers {
          rc.x0
        } else {
          cursor
        }
      expect cursor <= gap_end
      expect slice_eq(old, new, row_off + cursor, gap_end - cursor)
      check_row_gaps(
        old,
        new,
        row_off,
        y,
        rest,
        if covers {
          rc.x1
        } else {
          cursor
        },
      )
    }
  }
}

fn check_rows(
  old: ByteArray,
  new: ByteArray,
  leaf_idx: Int,
  r: Int,
  rects: List<Coordinates>,
) -> Bool {
  if r >= rows_per_leaf {
    True
  } else {
    let y = leaf_idx * rows_per_leaf + r
    expect check_row_gaps(old, new, r * line_length, y, rects, 0)
    check_rows(old, new, leaf_idx, r + 1, rects)
  }
}

/// each named ownership NFT sits in a reference input whose pub-key holder
/// signed the tx
fn check_owner_rects(
  rects: List<Coordinates>,
  ownership_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  when rects is {
    [] -> True
    [rc, ..rest] -> {
      let nm = rect_name(rc)
      expect Some(ref_in) =
        list.find(
          tx.reference_inputs,
          fn(i) { quantity_of(i.output.value, ownership_hash, nm) == 1 },
        )
      expect VerificationKey(holder) = ref_in.output.address.payment_credential
      expect list.has(tx.extra_signatories, holder)
      check_owner_rects(rest, ownership_hash, tx)
    }
  }
}

validator masterpiece(
  ownership_hash: ByteArray,
  genesis_utxo: OutputReference,
  bmp_header: ByteArray,
) {
  mint(redeemer: MintRedeemer, policy: PolicyId, tx: Transaction) {
    let MpInit { genesis_idx } = redeemer
    expect Some(genesis_in) = list.at(tx.inputs, genesis_idx)
    expect genesis_in.output_reference == genesis_utxo
    // exact mint
    expect
      tx.mint == merge(
        from_asset(policy, leaf_nft_name, n_leafs),
        merge(
          from_asset(policy, root_ref_nft_name, 1),
          from_asset(policy, root_user_nft_name, 1),
        ),
      )
    let own_addr = own_address(policy)
    // all leaf markers in one Nursery node, ready to hatch leaf 0
    expect Some(nursery_out) =
      list.find(
        tx.outputs,
        fn(o) { quantity_of(o.value, policy, leaf_nft_name) == n_leafs },
      )
    expect nursery_out.address == own_addr
    expect InlineDatum(nd) = nursery_out.datum
    expect Nursery { next_idx }: MasterpieceDatum = nd
    expect next_idx == 0
    // the CIP-68 reference NFT with the root datum
    expect Some(root_out) =
      list.find(
        tx.outputs,
        fn(o) { quantity_of(o.value, policy, root_ref_nft_name) == 1 },
      )
    expect root_out.address == own_addr
    expect InlineDatum(rd) = root_out.datum
    expect RootNft { metadata, version, extra }: MasterpieceDatum = rd
    // genesis honesty: every entry is the all-white chunk's CID
    let init_cid = cid_v1_raw(initial_chunk())
    expect list.length(extra.leafs_cids) == n_leafs
    expect list.all(extra.leafs_cids, fn(c) { c == init_cid })
    let root_cid = whole_image_cid_of(bmp_header, extra.leafs_cids)
    expect extra.raw_cid == root_cid
    expect version == 1
    expect list.length(metadata) == 3
    expect pairs.get_first(metadata, metadata_name_key) == Some(root_display_name)
    expect
      pairs.get_first(metadata, metadata_image_key) == Some(
        cid_to_ipfs_uri(root_cid),
      )
    expect
      pairs.get_first(metadata, metadata_media_type_key) == Some(media_type_bmp)
    True
  }

  spend(
    datum: Option<Data>,
    redeemer: Data,
    oref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(raw) = datum
    expect state: MasterpieceDatum = raw
    expect Some(own_in) = list.find(tx.inputs, fn(i) { i.output_reference == oref })
    let own_addr = own_in.output.address
    expect Script(policy) = own_addr.payment_credential
    when state is {
      // sync ONE edited leaf's CID into the root
      RootNft { metadata, extra, .. } -> {
        expect Commit { ref_idx }: CommitRedeemer = redeemer
        expect quantity_of(own_in.output.value, policy, root_ref_nft_name) == 1
        // continuing root output
        expect [root_out] =
          list.filter(
            tx.outputs,
            fn(o) {
              o.address == own_addr && quantity_of(
                o.value,
                policy,
                root_ref_nft_name,
              ) == 1
            },
          )
        expect InlineDatum(rod) = root_out.datum
        expect RootNft { metadata: new_md, version: new_ver, extra: new_ext }:
          MasterpieceDatum = rod
        // the ONE committed leaf
        expect Some(ri) = list.at(tx.reference_inputs, ref_idx)
        expect ri.output.address == own_addr
        expect quantity_of(ri.output.value, policy, leaf_nft_name) == 1
        expect InlineDatum(rld) = ri.output.datum
        expect LeafNode { idx: lidx, raw_cid: lcid, .. }: MasterpieceDatum = rld
        expect list.length(new_ext.leafs_cids) == n_leafs
        expect
          check_cid_update(extra.leafs_cids, new_ext.leafs_cids, 0, lidx, lcid)
        let new_root_cid = whole_image_cid_of(bmp_header, new_ext.leafs_cids)
        expect new_ext.raw_cid == new_root_cid
        expect new_ver == 1
        expect list.length(new_md) == 3
        expect
          pairs.get_first(new_md, metadata_name_key) == pairs.get_first(
            metadata,
            metadata_name_key,
          )
        expect
          pairs.get_first(new_md, metadata_media_type_key) == pairs.get_first(
            metadata,
            metadata_media_type_key,
          )
        pairs.get_first(new_md, metadata_image_key) == Some(
          cid_to_ipfs_uri(new_root_cid),
        )
      }
      // chunk integrity + pixel ownership of every changed byte
      LeafNode { idx: li, chunk: old_chunk, .. } -> {
        expect Edit { owner_rects }: EditRedeemer = redeemer
        expect quantity_of(own_in.output.value, policy, leaf_nft_name) == 1
        // continuing leaf output (unique: markers never leave)
        expect [leaf_out] =
          list.filter(
            tx.outputs,
            fn(o) {
              o.address == own_addr && quantity_of(o.value, policy, leaf_nft_name) == 1
            },
          )
        expect InlineDatum(lod) = leaf_out.datum
        expect LeafNode { idx: new_idx, raw_cid: new_cid, chunk: new_chunk }:
          MasterpieceDatum = lod
        expect new_idx == li
        expect builtin.length_of_bytearray(new_chunk) == chunk_size
        expect new_cid == cid_v1_raw(new_chunk)
        expect check_owner_rects(owner_rects, ownership_hash, tx)
        check_rows(old_chunk, new_chunk, li, 0, owner_rects)
      }
      // peel off exactly one leaf, in index order
      Nursery { next_idx } -> {
        let remaining = n_leafs - next_idx
        expect quantity_of(own_in.output.value, policy, leaf_nft_name) == remaining
        let init_ch = initial_chunk()
        let init_cid = cid_v1_raw(init_ch)
        let own_outs =
          list.filter(
            tx.outputs,
            fn(o) {
              o.address == own_addr && quantity_of(o.value, policy, leaf_nft_name) > 0
            },
          )
        expect [leaf_out, ..rest_outs] = own_outs
        expect quantity_of(leaf_out.value, policy, leaf_nft_name) == 1
        expect InlineDatum(ld) = leaf_out.datum
        expect LeafNode { idx: lidx, raw_cid: lcid, chunk: lch }:
          MasterpieceDatum = ld
        expect lidx == next_idx
        expect lcid == init_cid
        expect lch == init_ch
        if next_idx < n_leafs - 1 {
          expect [nursery_out] = rest_outs
          expect
            quantity_of(nursery_out.value, policy, leaf_nft_name) == remaining - 1
          expect InlineDatum(nd) = nursery_out.datum
          expect Nursery { next_idx: nn }: MasterpieceDatum = nd
          nn == next_idx + 1
        } else {
          // last hatch: every marker now lives on a leaf
          rest_outs == []
        }
      }
    }
  }

  else(_) {
    fail
  }
}
