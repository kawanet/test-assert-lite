import type * as declared from "test-assert-lite"
import {AssertionError} from "./assert/assertion-error.ts"
import {deepEqualPair, looseSame} from "./assert/deep-equal.ts"
import {doesNotReject, rejects} from "./assert/rejects.ts"
import {doesNotThrow, throws} from "./assert/throws.ts"
import {isError} from "./utils/is-error.ts"
import {messageOf, stringify} from "./utils/stringify.ts"

// An Error passed as the message is thrown as it is. node:assert applies
// that rule to every assertion, not only to fail().
const ok: declared.TAL.Assert["ok"] = (value, message) => {
    if (value) return
    if (isError(message)) throw message
    throw new AssertionError({
        message: message ?? `expected truthy, got ${stringify(value)}`,
        actual: value, expected: true, operator: "ok",
    })
}

type Equality = (actual: unknown, expected: unknown, message?: string | Error) => void

// Strict compares with Object.is: NaN equals NaN, and 0 differs from -0.
// Loose compares with ==, NaN still equal to itself, as node's equal does.
const equalPair = (strict: boolean): {equal: Equality, notEqual: Equality} => {
    const same = strict ? Object.is : looseSame

    const equal: Equality = (actual, expected, message) => {
        if (same(actual, expected)) return
        if (isError(message)) throw message

        // Keep the values even when a message is given: without them there
        // is nothing to start from. node:assert does this for strictEqual alone.
        const detail = `expected ${stringify(expected)}, got ${stringify(actual)}`
        throw new AssertionError({
            message: message == null ? detail : `${message}\n\n${detail}`,
            actual, expected, operator: strict ? "strictEqual" : "equal",
        })
    }

    const notEqual: Equality = (actual, expected, message) => {
        if (!same(actual, expected)) return
        if (isError(message)) throw message
        throw new AssertionError({
            message: message ?? `expected not ${stringify(expected)}`,
            actual, expected, operator: strict ? "notStrictEqual" : "notEqual",
        })
    }

    return {equal, notEqual}
}

// The four assertions that come in a strict and a loose flavour; the
// strict ones also serve as the *StrictEqual names of both.
const flavour = (strict: boolean) => ({...equalPair(strict), ...deepEqualPair(strict)})

const match = (value: string, regExp: RegExp, message?: string | Error): void => {
    if (regExp.test(value)) return
    if (isError(message)) throw message
    throw new AssertionError({
        message: message ?? `${stringify(value)} did not match ${regExp}`,
        actual: value, expected: regExp, operator: "match",
    })
}

const doesNotMatch = (value: string, regExp: RegExp, message?: string | Error): void => {
    if (!regExp.test(value)) return
    if (isError(message)) throw message
    throw new AssertionError({
        message: message ?? `${stringify(value)} matched ${regExp}`,
        actual: value, expected: regExp, operator: "doesNotMatch",
    })
}

// The assertions hold no state, so they sit at module level and the factory
// only assembles them. Options such as a diff mode would enter here.
export interface AssertControl {
    // node's `assert`: equal / deepEqual are the loose ones.
    assert: declared.TAL.Assert
    // node's `assert.strict`: the same names, all strict.
    strict: declared.TAL.Assert
    methods: declared.TAL.AssertMethods
}

export const createAssert = (): AssertControl => {
    const strictOnly = flavour(true)
    const looseOnly = flavour(false)

    const shared = {
        fail: (message?: string | Error): never => {
            if (isError(message)) throw message
            throw new AssertionError({
                message: message ?? "Failed",
                operator: "fail",
            })
        },
        strictEqual: strictOnly.equal,
        notStrictEqual: strictOnly.notEqual,
        deepStrictEqual: strictOnly.deepEqual,
        notDeepStrictEqual: strictOnly.notDeepEqual,
        throws,
        doesNotThrow,
        rejects,
        doesNotReject,
        match,
        doesNotMatch,
    }

    const ifError = (value: unknown): void => {
        if (value == null) return
        throw new AssertionError({
            message: `ifError got unwanted exception: ${messageOf(value)}`,
            actual: value, operator: "ifError",
        })
    }

    // For t.assert, which in node:test carries the loose equal / deepEqual
    // like the plain assert. ok / ifError are plain checks here, not
    // assertion signatures.
    const methods: declared.TAL.AssertMethods = {...shared, ...looseOnly, ok, ifError}

    // The node:assert shape, where the module itself works as ok.
    const callable = (own: ReturnType<typeof flavour>): declared.TAL.Assert => Object.assign(
        ((value: unknown, message?: string | Error) => ok(value, message)) as declared.TAL.Assert,
        shared,
        own,
        {ok, ifError: ifError as declared.TAL.Assert["ifError"]},
    )

    const strict = callable(strictOnly)
    const assert = callable(looseOnly)
    // As in node, `.strict` leads to the strict one from either.
    assert.strict = strict
    strict.strict = strict

    return {assert, strict, methods}
}
