/**
 * `test-assert-lite/assert/strict`, the stand-in for `node:assert/strict`.
 * The default export is the assert function itself, methods attached.
 */

import type {TAL} from "./test-assert-lite"

declare const strict: TAL.Assert

export default strict
