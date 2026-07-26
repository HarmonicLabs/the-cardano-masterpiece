//// Lock — utxos here are permanently unspendable (ref-script parking).
//// Mirror of src/lock.pebble.

validator lock {
  else(_) {
    fail
  }
}
