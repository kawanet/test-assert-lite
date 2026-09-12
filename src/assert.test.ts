import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import * as TAL from "./index.ts"

const TITLE = "assert.test.ts"

const catchError = (fn: () => unknown): Error | undefined => {
    try {
        fn()
        return undefined
    } catch (e) {
        return e as Error
    }
}

// An Error that arrives from an iframe or a worker has a different
// constructor, so instanceof says no. Replacing the prototype reproduces
// that state without a vm, which keeps this runnable in a browser.
const foreignError = (message: string): Error => {
    const error = new TypeError(message)
    Object.setPrototypeOf(error, {name: "TypeError"})
    return error
}
describe(TITLE, () => {
    it("callable form works as ok", () => {
        assert.doesNotThrow(() => TAL.strict(1))
        assert.throws(() => TAL.strict(0), /expected truthy/)
    })

    it("ok", () => {
        assert.doesNotThrow(() => TAL.strict.ok("x"))
        assert.throws(() => TAL.strict.ok(""), /expected truthy/)
        assert.throws(() => TAL.strict.ok(false, "custom"), /custom/)
    })

    it("equal uses Object.is semantics", () => {
        assert.doesNotThrow(() => TAL.strict.equal(NaN, NaN))
        assert.throws(() => TAL.strict.equal(0, -0))
        assert.throws(() => TAL.strict.equal("a", "b"), /expected "b", got "a"/)
    })

    it("strictEqual is an alias of equal", () => {
        assert.equal(TAL.strict.strictEqual, TAL.strict.equal)
        assert.equal(TAL.strict.notStrictEqual, TAL.strict.notEqual)
    })

    it("notEqual", () => {
        assert.doesNotThrow(() => TAL.strict.notEqual(1, 2))
        assert.throws(() => TAL.strict.notEqual(1, 1), /expected not 1/)
    })

    // node's `assert` (as opposed to `assert.strict`) compares with ==,
    // NaN still equal to itself; the *StrictEqual names stay strict there.
    it("assert compares loosely in equal / notEqual, strictly in strictEqual", () => {
        assert.doesNotThrow(() => TAL.assert.equal(1, "1"))
        assert.doesNotThrow(() => TAL.assert.equal(0, -0))
        assert.doesNotThrow(() => TAL.assert.equal(null, undefined))
        assert.doesNotThrow(() => TAL.assert.equal(NaN, NaN))
        assert.throws(() => TAL.assert.equal(1, "2"), /expected "2", got 1/)
        assert.throws(() => TAL.assert.notEqual(1, "1"), /expected not "1"/)
        assert.doesNotThrow(() => TAL.assert.notEqual(1, 2))

        assert.throws(() => TAL.assert.strictEqual(1, "1"))
        assert.doesNotThrow(() => TAL.assert.notStrictEqual(1, "1"))
        assert.equal(TAL.assert.strictEqual, TAL.strict.equal)
        assert.equal(TAL.assert.deepStrictEqual, TAL.strict.deepEqual)
    })

    it("assert reaches the same loose deepEqual, and the strict one by its name", () => {
        assert.doesNotThrow(() => TAL.assert.deepEqual({a: 1}, {a: "1"}))
        assert.throws(() => TAL.assert.deepStrictEqual({a: 1}, {a: "1"}), /deep-equal/)
        assert.throws(() => TAL.assert.notDeepEqual({a: 1}, {a: "1"}), /expected not to deep-equal/)
    })

    // Both callables work as ok, and both lead to the strict one via .strict.
    it("assert is callable like strict, and .strict leads to strict from either", () => {
        assert.doesNotThrow(() => TAL.assert(1))
        assert.throws(() => TAL.assert(0), /expected truthy/)
        assert.equal(TAL.assert.strict, TAL.strict)
        assert.equal(TAL.strict.strict, TAL.strict)
        assert.notEqual(TAL.assert, TAL.strict)
    })

    // Everything that has no loose counterpart is the very same function.
    it("assert and strict share fail / throws / rejects / match / ok / ifError", () => {
        assert.equal(TAL.assert.fail, TAL.strict.fail)
        assert.equal(TAL.assert.throws, TAL.strict.throws)
        assert.equal(TAL.assert.doesNotThrow, TAL.strict.doesNotThrow)
        assert.equal(TAL.assert.rejects, TAL.strict.rejects)
        assert.equal(TAL.assert.doesNotReject, TAL.strict.doesNotReject)
        assert.equal(TAL.assert.match, TAL.strict.match)
        assert.equal(TAL.assert.doesNotMatch, TAL.strict.doesNotMatch)
        assert.equal(TAL.assert.ok, TAL.strict.ok)
        assert.equal(TAL.assert.ifError, TAL.strict.ifError)
    })

    it("the loose failures name the loose operators", () => {
        const operator = (fn: () => void): string | undefined => (catchError(fn) as {operator?: string} | undefined)?.operator
        assert.equal(operator(() => TAL.assert.equal(1, 2)), "equal")
        assert.equal(operator(() => TAL.assert.notEqual(1, 1)), "notEqual")
        assert.equal(operator(() => TAL.strict.equal(1, 2)), "strictEqual")
        assert.equal(operator(() => TAL.strict.notEqual(1, 1)), "notStrictEqual")
    })
    it("match and doesNotMatch", () => {
        assert.doesNotThrow(() => TAL.strict.match("abc", /b/))
        assert.throws(() => TAL.strict.match("abc", /z/), /did not match/)
        assert.doesNotThrow(() => TAL.strict.doesNotMatch("abc", /z/))
        assert.throws(() => TAL.strict.doesNotMatch("abc", /b/), /matched/)
    })

    it("ifError", () => {
        assert.doesNotThrow(() => TAL.strict.ifError(null))
        assert.doesNotThrow(() => TAL.strict.ifError(undefined))
        assert.throws(() => TAL.strict.ifError(new Error("x")), /unwanted exception: x$/)
        assert.throws(() => TAL.strict.ifError(new TypeError()), /unwanted exception: TypeError$/)
        assert.throws(() => TAL.strict.ifError("str"), /unwanted exception: "str"$/)
    })

    it("fail", () => {
        assert.throws(() => TAL.strict.fail(), /Failed/)
        assert.throws(() => TAL.strict.fail("why"), /why/)
    })

    // The message alone does not say which value arrived.
    it("equal keeps the values alongside a custom message", () => {
        const error = catchError(() => TAL.strict.equal(1, 2, "blah"))

        assert.match(String(error?.message), /^blah\n\nexpected 2, got 1$/)
        assert.equal(catchError(() => TAL.strict.notEqual(5, 5, "blah"))?.message, "blah")
    })

    it("an Error passed as message is thrown as is", () => {
        const sentinel = new Error("sentinel")
        assert.equal(catchError(() => TAL.strict.ok(false, sentinel)), sentinel)
    })

    it("an Error from another realm is thrown as is", () => {
        const sentinel = foreignError("from another realm")

        assert.ok(catchError(() => TAL.strict.ok(false, sentinel)) === sentinel, "ok wrapped it")
        assert.ok(catchError(() => TAL.strict.equal(1, 2, sentinel)) === sentinel, "equal wrapped it")
        assert.ok(catchError(() => TAL.strict.match("a", /b/, sentinel)) === sentinel, "match wrapped it")
        assert.ok(catchError(() => TAL.strict.fail(sentinel)) === sentinel, "fail wrapped it")
    })

    // A plain object shaped like an Error stays a message.
    it("an object that only looks like an Error is not one", () => {
        const error = catchError(() => TAL.strict.ok(false, {name: "Error", message: "x"} as never))

        assert.equal(error?.name, "AssertionError")
    })

    it("AssertionError carries actual and expected", () => {
        const error = catchError(() => TAL.strict.equal("got", "want")) as Error & {
            code?: string, actual?: unknown, expected?: unknown, operator?: string,
        }
        assert.equal(error?.name, "AssertionError")
        assert.equal(error?.code, "ERR_ASSERTION")
        assert.equal(error?.actual, "got")
        assert.equal(error?.expected, "want")
        assert.equal(error?.operator, "strictEqual")
    })
})
