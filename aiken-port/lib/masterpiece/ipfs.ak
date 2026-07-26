//// On-chain IPFS CIDv1 computation — mirror of src/lib/ipfs.pebble
//// (byte-exact with `ipfs add --cid-version=1 --raw-leaves`).

use aiken/builtin
use aiken/crypto.{sha2_256}
use aiken/primitive/bytearray

fn rb(v: Int) -> ByteArray {
  builtin.replicate_byte(1, v)
}

/// LEB128 unsigned varint (values < 2^35)
pub fn uvarint(n: Int) -> ByteArray {
  let b0 = n % 128
  let r0 = n / 128
  let b1 = r0 % 128
  let r1 = r0 / 128
  let b2 = r1 % 128
  let r2 = r1 / 128
  let b3 = r2 % 128
  let r3 = r2 / 128
  let b4 = r3 % 128
  if r0 == 0 {
    rb(b0)
  } else if r1 == 0 {
    bytearray.concat(rb(b0 + 128), rb(b1))
  } else if r2 == 0 {
    bytearray.concat(rb(b0 + 128), bytearray.concat(rb(b1 + 128), rb(b2)))
  } else if r3 == 0 {
    bytearray.concat(
      rb(b0 + 128),
      bytearray.concat(rb(b1 + 128), bytearray.concat(rb(b2 + 128), rb(b3))),
    )
  } else {
    bytearray.concat(
      rb(b0 + 128),
      bytearray.concat(
        rb(b1 + 128),
        bytearray.concat(rb(b2 + 128), bytearray.concat(rb(b3 + 128), rb(b4))),
      ),
    )
  }
}

/// CIDv1 raw (leaf) from chunk content: 0x01 0x55 0x12 0x20 || sha256(chunk)
pub fn cid_v1_raw(content: ByteArray) -> ByteArray {
  bytearray.concat(#"01551220", sha2_256(content))
}

/// one PBLink (field 2 of the root): 12 <len> | 0a 24 <cid> | 12 00 | 18 <varint tsize>
pub fn pb_link(child_cid: ByteArray, tsize: Int) -> ByteArray {
  let body =
    bytearray.concat(
      bytearray.concat(bytearray.concat(#"0a24", child_cid), #"120018"),
      uvarint(tsize),
    )
  bytearray.concat(bytearray.concat(#"12", uvarint(bytearray.length(body))), body)
}

/// UnixFS Data message for a File: 08 02 | 18 <varint filesize> | { 20 <varint blocksize> }*
pub fn unixfs_file(filesize: Int, blocksizes: List<Int>) -> ByteArray {
  let head = bytearray.concat(#"0802", bytearray.concat(#"18", uvarint(filesize)))
  do_blocksizes(head, blocksizes)
}

fn do_blocksizes(acc: ByteArray, bs: List<Int>) -> ByteArray {
  when bs is {
    [] -> acc
    [b, ..rest] ->
      do_blocksizes(bytearray.concat(acc, bytearray.concat(#"20", uvarint(b))), rest)
  }
}

/// serialized dag-pb root node: all Links (field 2) first, then the Data field (field 1)
pub fn dag_pb_file_root(
  child_cids: List<ByteArray>,
  tsizes: List<Int>,
  filesize: Int,
  blocksizes: List<Int>,
) -> ByteArray {
  let links = do_links(#"", child_cids, tsizes)
  let dat = unixfs_file(filesize, blocksizes)
  let data_field =
    bytearray.concat(bytearray.concat(#"0a", uvarint(bytearray.length(dat))), dat)
  bytearray.concat(links, data_field)
}

fn do_links(acc: ByteArray, cids: List<ByteArray>, tsizes: List<Int>) -> ByteArray {
  when cids is {
    [] -> acc
    [c, ..cs] ->
      when tsizes is {
        [] -> fail @"tsizes shorter than cids"
        [t, ..ts] -> do_links(bytearray.concat(acc, pb_link(c, t)), cs, ts)
      }
  }
}

/// whole-image CIDv1 (dag-pb, codec 0x70) over the raw-leaf chunks
pub fn whole_image_cid(
  child_cids: List<ByteArray>,
  tsizes: List<Int>,
  filesize: Int,
  blocksizes: List<Int>,
) -> ByteArray {
  bytearray.concat(
    #"01701220",
    sha2_256(dag_pb_file_root(child_cids, tsizes, filesize, blocksizes)),
  )
}

// ---------------------------------------------------------------------------
// CIDv1 -> base32 multibase string ("bafy...") — RFC4648 lowercase, no padding
// ---------------------------------------------------------------------------

// alphabet "abcdefghijklmnopqrstuvwxyz234567"
const b32_alphabet: ByteArray = #"6162636465666768696a6b6c6d6e6f707172737475767778797a323334353637"

fn b32_char(idx: Int) -> ByteArray {
  builtin.replicate_byte(1, builtin.index_bytearray(b32_alphabet, idx))
}

/// one 5-byte (40-bit) group -> 8 base32 chars
fn b32_group(d: ByteArray, off: Int) -> ByteArray {
  let b0 = builtin.index_bytearray(d, off)
  let b1 = builtin.index_bytearray(d, off + 1)
  let b2 = builtin.index_bytearray(d, off + 2)
  let b3 = builtin.index_bytearray(d, off + 3)
  let b4 = builtin.index_bytearray(d, off + 4)
  bytearray.concat(
    bytearray.concat(
      bytearray.concat(b32_char(b0 / 8), b32_char(b0 % 8 * 4 + b1 / 64)),
      bytearray.concat(b32_char(b1 / 2 % 32), b32_char(b1 % 2 * 16 + b2 / 16)),
    ),
    bytearray.concat(
      bytearray.concat(b32_char(b2 % 16 * 2 + b3 / 128), b32_char(b3 / 4 % 32)),
      bytearray.concat(b32_char(b3 % 4 * 8 + b4 / 32), b32_char(b4 % 32)),
    ),
  )
}

/// base32 of a 36-byte CIDv1 (7 full groups + 1 leftover byte -> 58 chars), 'b'-prefixed
pub fn base32_cid(cid: ByteArray) -> ByteArray {
  let out = do_groups(#"62", cid, 0)
  let b = builtin.index_bytearray(cid, 35)
  bytearray.concat(out, bytearray.concat(b32_char(b / 8), b32_char(b % 8 * 4)))
}

fn do_groups(acc: ByteArray, cid: ByteArray, g: Int) -> ByteArray {
  if g >= 7 {
    acc
  } else {
    do_groups(bytearray.concat(acc, b32_group(cid, g * 5)), cid, g + 1)
  }
}

/// CIP-68 `image` value: "ipfs://" + base32 CIDv1
pub fn cid_to_ipfs_uri(cid: ByteArray) -> ByteArray {
  bytearray.concat(#"697066733a2f2f", base32_cid(cid))
}

test uvarint_examples() {
  and {
    uvarint(0) == #"00",
    uvarint(127) == #"7f",
    uvarint(128) == #"8001",
    uvarint(12096) == #"c05e",
    uvarint(300) == #"ac02",
    uvarint(1048576) == #"808040",
  }
}
