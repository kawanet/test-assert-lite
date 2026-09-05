// Entry for `test-assert-lite/test`, the stand-in for `node:test`. Only
// re-exports, so a suite registered through here lands in the same default
// harness that `test-assert-lite` runs.
export {after, before, describe, it, suite, test} from "../index.ts"
