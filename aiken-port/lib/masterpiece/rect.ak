//// Rectangle utilities for the 1008x1008 canvas — mirror of src/lib/rect.pebble.
//// Rectangles are half-open: [x0,x1) x [y0,y1), x in 0..1008, y in 0..1008.

use aiken/builtin
use aiken/primitive/bytearray

pub const canvas_width: Int = 1008

pub const canvas_height: Int = 1008

/// Encodes as Constr 0 [x0, y0, x1, y1] — byte-identical to the Pebble ABI.
pub type Coordinates {
  x0: Int,
  y0: Int,
  x1: Int,
  y1: Int,
}

pub fn is_valid_rect(r: Coordinates) -> Bool {
  0 <= r.x0 && r.x0 < r.x1 && r.x1 <= canvas_width && 0 <= r.y0 && r.y0 < r.y1 && r.y1 <= canvas_height
}

pub fn rect_contains(outer: Coordinates, inner: Coordinates) -> Bool {
  outer.x0 <= inner.x0 && inner.x1 <= outer.x1 && outer.y0 <= inner.y0 && inner.y1 <= outer.y1
}

pub fn rect_area(r: Coordinates) -> Int {
  ( r.x1 - r.x0 ) * ( r.y1 - r.y0 )
}

pub fn same_rect(a: Coordinates, b: Coordinates) -> Bool {
  a.x0 == b.x0 && a.y0 == b.y0 && a.x1 == b.x1 && a.y1 == b.y1
}

/// `a` and `b` are a single straight (guillotine) cut of `p`, in order.
pub fn is_guillotine_cut(p: Coordinates, a: Coordinates, b: Coordinates) -> Bool {
  let vertical =
    a.x0 == p.x0 && a.x1 == b.x0 && b.x1 == p.x1 && a.y0 == p.y0 && a.y1 == p.y1 && b.y0 == p.y0 && b.y1 == p.y1 && a.x0 < a.x1 && b.x0 < b.x1
  let horizontal =
    a.y0 == p.y0 && a.y1 == b.y0 && b.y1 == p.y1 && a.x0 == p.x0 && a.x1 == p.x1 && b.x0 == p.x0 && b.x1 == p.x1 && a.y0 < a.y1 && b.y0 < b.y1
  vertical || horizontal
}

// "masterpiece-"
const name_prefix: ByteArray = #"6d617374657270696563652d"

fn dec_digit(d: Int) -> ByteArray {
  builtin.replicate_byte(1, 48 + d)
}

/// canonical decimal for 0..9999 (ample for coords in 0..1008)
fn dec_num(v: Int) -> ByteArray {
  let last = dec_digit(v % 10)
  if v < 10 {
    last
  } else if v < 100 {
    bytearray.concat(dec_digit(v / 10), last)
  } else if v < 1000 {
    bytearray.concat(bytearray.concat(dec_digit(v / 100), dec_digit(v / 10 % 10)), last)
  } else {
    bytearray.concat(
      bytearray.concat(dec_digit(v / 1000), dec_digit(v / 100 % 10)),
      bytearray.concat(dec_digit(v / 10 % 10), last),
    )
  }
}

/// "masterpiece-x0-y0-x1-y1"
pub fn rect_name(r: Coordinates) -> ByteArray {
  bytearray.concat(
    bytearray.concat(
      name_prefix,
      bytearray.concat(dec_num(r.x0), bytearray.concat(#"2d", dec_num(r.y0))),
    ),
    bytearray.concat(
      bytearray.concat(#"2d", dec_num(r.x1)),
      bytearray.concat(#"2d", dec_num(r.y1)),
    ),
  )
}

test rect_name_examples() {
  and {
    rect_name(Coordinates { x0: 0, y0: 0, x1: 1008, y1: 1008 }) == "masterpiece-0-0-1008-1008",
    rect_name(Coordinates { x0: 12, y0: 13, x1: 17, y1: 18 }) == "masterpiece-12-13-17-18",
    rect_name(Coordinates { x0: 100, y0: 999, x1: 1000, y1: 1000 }) == "masterpiece-100-999-1000-1000",
  }
}
