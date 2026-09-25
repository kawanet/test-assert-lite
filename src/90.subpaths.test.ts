// Pins the subpath entries. Each takes its objects from the shared harness,
// so the checks are identity against it as the package resolves it, and
// the named lists must not drift from what the harness exposes. The
// declaration assignments make tsc read the bridges' .d.ts too.
import {strict as assert} from "node:assert"
import {test} from "node:test"
import {sharedTAL} from "test-assert-lite"
import * as assertEntry from "test-assert-lite/assert"
import * as strictEntry from "test-assert-lite/assert/strict"
import * as htmlEntry from "test-assert-lite/reporter/html"
import * as specEntry from "test-assert-lite/reporter/spec"
import * as tapEntry from "test-assert-lite/reporter/tap"
import * as sessionEntry from "test-assert-lite/session"
import * as testEntry from "test-assert-lite/test"

const named = (entry: object): string[] => Object.keys(entry).filter(key => key !== "default").sort()

test("test-assert-lite/test", () => {
    const typed: typeof sharedTAL.test.test = testEntry.default
    void typed
    assert.equal(testEntry.default, sharedTAL.test.test)
    assert.deepEqual(named(testEntry), ["after", "before", "describe", "it", "suite", "test"])
    for (const key of named(testEntry)) {
        assert.equal(testEntry[key as keyof typeof testEntry], sharedTAL.test[key as keyof typeof sharedTAL.test], key)
    }
})

test("test-assert-lite/assert", () => {
    const typed: typeof sharedTAL.assert = assertEntry.default
    void typed
    assert.equal(assertEntry.default, sharedTAL.assert)
    assert.equal(assertEntry.strict, sharedTAL.assert.strict)
    assert.deepEqual(named(assertEntry), Object.keys(sharedTAL.assert).sort())
    for (const key of named(assertEntry)) {
        assert.equal(assertEntry[key as keyof typeof assertEntry], sharedTAL.assert[key as keyof typeof sharedTAL.assert], key)
    }
})

test("test-assert-lite/assert/strict", () => {
    const typed: typeof sharedTAL.assert.strict = strictEntry.default
    void typed
    assert.equal(strictEntry.default, sharedTAL.assert.strict)
    assert.equal(strictEntry.strict, sharedTAL.assert.strict)
    assert.deepEqual(named(strictEntry), Object.keys(sharedTAL.assert.strict).sort())
    for (const key of named(strictEntry)) {
        assert.equal(strictEntry[key as keyof typeof strictEntry], sharedTAL.assert.strict[key as keyof typeof sharedTAL.assert.strict], key)
    }
})

test("test-assert-lite/session", () => {
    const typed: typeof sharedTAL.session.session = sessionEntry.session
    void typed
    assert.equal(sessionEntry.session, sharedTAL.session.session)
    assert.equal(sessionEntry.load, sharedTAL.session.load)
    assert.equal(sessionEntry.end, sharedTAL.session.end)
    assert.equal(sessionEntry.stdout, sharedTAL.session.stdout)
    assert.equal(sessionEntry.stderr, sharedTAL.session.stderr)
    assert.equal(sessionEntry.bridge, sharedTAL.session.bridge)
    assert.deepEqual(named(sessionEntry), ["bridge", "end", "load", "session", "stderr", "stdout"])
})

test("test-assert-lite/reporter/html", () => {
    assert.equal(typeof htmlEntry.default, "function")
})

test("test-assert-lite/reporter/spec", () => {
    assert.equal(typeof specEntry.default, "function")
})

test("test-assert-lite/reporter/tap", () => {
    assert.equal(typeof tapEntry.default, "function")
})
