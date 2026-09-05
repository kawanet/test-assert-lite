// Pins the subpath entries and the CommonJS surface. Everything here is
// resolved through the package name, so it runs against dist/: a checkout
// self-references it, and the pack test installs the tarball.
import {strict as assert} from "node:assert"
import {createRequire} from "node:module"
import {test} from "node:test"

import * as root from "test-assert-lite"
import type * as declaredAssert from "test-assert-lite/assert"
import * as assertEntry from "test-assert-lite/assert"
import strictEntry from "test-assert-lite/assert/strict"
import type * as declaredTest from "test-assert-lite/test"
import * as testEntry from "test-assert-lite/test"

const testSurface: typeof declaredTest = testEntry
const assertSurface: typeof declaredAssert = assertEntry
void testSurface
void assertSurface

// The same functions, not copies: a suite registered through the subpath
// must land in the harness that the root's run() executes.
test("test-assert-lite/test shares the root harness", () => {
    assert.equal(testEntry.after, root.after)
    assert.equal(testEntry.before, root.before)
    assert.equal(testEntry.describe, root.describe)
    assert.equal(testEntry.it, root.it)
    assert.equal(testEntry.suite, root.suite)
    assert.equal(testEntry.test, root.test)
})

test("test-assert-lite/assert exports the root strict", () => {
    assert.equal(assertEntry.strict, root.strict)
})

test("test-assert-lite/assert/strict is the root strict itself", () => {
    assert.equal(strictEntry, root.strict)
    assert.equal(typeof strictEntry.equal, "function")
})

// On Node 20.19 and later require() reaches the .mjs; below that it falls
// back to the CommonJS glue, so only the shape is pinned here.
test("require() reaches the package and its subpaths", () => {
    const require = createRequire(import.meta.url)

    const cjs = require("test-assert-lite")
    assert.equal(typeof cjs.run, "function")
    assert.equal(typeof cjs.strict, "function")
    assert.equal(typeof cjs.describe, "function")

    assert.equal(typeof require("test-assert-lite/test").describe, "function")
    assert.equal(typeof require("test-assert-lite/assert").strict, "function")
    assert.equal(typeof require("test-assert-lite/assert/strict").equal, "function")
})
