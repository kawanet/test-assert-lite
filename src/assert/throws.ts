import type * as declared from "test-assert-lite"
import {isError} from "../utils/is-error.ts"
import {stringify} from "../utils/stringify.ts"
import {AssertionError} from "./assertion-error.ts"

type Predicate = declared.TAL.AssertPredicate
type Filter = declared.TAL.ErrorFilter

// The one error for a misuse of any of these assertions, whatever was
// wrong with the arguments. What matters is that it is not an AssertionError.
export const invalid = (): TypeError => new TypeError("invalid arguments")

// What a block produced, wrapped so that a thrown undefined is still told
// apart from nothing thrown, as node:assert tells them apart. rejects.ts
// builds the same shape from how a promise settled.
export type Outcome = {thrown: unknown} | null

const attempt = (block: () => unknown): Outcome => {
    try {
        block()
        return null
    } catch (e) {
        return {thrown: e}
    }
}

const isErrorClass = (fn: Function): boolean => fn === Error || Error.prototype.isPrototypeOf(fn.prototype)

// The properties an object matcher asks for. name and message come along
// when the object is itself an Error, where they are not enumerable.
const keysOf = (expected: object): string[] => isError(expected) ? [...Object.keys(expected), "name", "message"] : Object.keys(expected)

// A matcher shape node:assert takes. An object with nothing to compare
// would match anything, so it is refused as node:assert refuses it.
const isPredicate = (value: unknown): value is Predicate =>
    value instanceof RegExp || "function" === typeof value || ("object" === typeof value && value != null && keysOf(value).length > 0)

// Whether `thrown` satisfies `expected`, for every matcher node:assert takes:
// a RegExp against String(thrown), a class, a validation function, or an
// object whose properties thrown must carry.
const matches = (thrown: unknown, expected: Predicate): boolean => {
    if (expected instanceof RegExp) return expected.test(String(thrown))
    if ("function" === typeof expected) {
        // In node's order: any class answers by instanceof first, Error or
        // not. An arrow function has no prototype and is asked instead, as
        // is any other class, which throws on the call as it does in node.
        if (expected.prototype != null && thrown instanceof expected) return true
        if (isErrorClass(expected)) return false
        return (expected as (thrown: unknown) => boolean)(thrown) === true
    }
    if (thrown == null || "object" !== typeof thrown) return false

    const actual = thrown as Record<string, unknown>
    const wanted = expected as Record<string, unknown>
    return keysOf(expected).every(key => {
        if (!(key in actual)) return false
        const want = wanted[key]
        return want instanceof RegExp ? want.test(String(actual[key])) : Object.is(actual[key], want)
    })
}

// How the failure names what the block was expected to do.
const VERB = {throws: "throw", rejects: "reject", doesNotThrow: "throw", doesNotReject: "reject"} as const

// --- shared with rejects.ts ----------------------------------------------

// The `[expected, message]` tail throws and rejects take alike. As in
// node:assert a string in the second position is the message, and then a
// third argument is refused.
export interface Expectation {
    expected: Predicate | undefined
    message: string | Error | undefined
    messageOnly: boolean
}

export const readExpectation = (rest: [expected?: Predicate | string, message?: string | Error]): Expectation => {
    const [second, third] = rest
    const messageOnly = "string" === typeof second
    if (messageOnly && rest.length > 1) throw invalid()
    const expected = messageOnly ? undefined : second as Predicate | undefined
    const message = messageOnly ? second as string : third
    if (expected != null && !isPredicate(expected)) throw invalid()
    return {expected, message, messageOnly}
}

// The verdict throws and rejects share once the block has run.
export const expectError = (caught: Outcome, {expected, message, messageOnly}: Expectation, operator: "throws" | "rejects"): void => {
    if (caught == null) {
        if (isError(message)) throw message
        throw new AssertionError({
            message: message ?? `expected to ${VERB[operator]}, did not`,
            operator,
        })
    }
    const {thrown} = caught

    // A message equal to what was thrown was meant as a matcher; node:assert
    // refuses the call as ambiguous rather than letting it pass. Any thrown
    // object is read by its message, not only an Error.
    const said = thrown != null && "object" === typeof thrown ? (thrown as {message?: unknown}).message : thrown
    if (messageOnly && said === message) throw invalid()

    if (expected != null && !matches(thrown, expected)) {
        if (isError(message)) throw message
        throw new AssertionError({
            message: message ?? `${stringify(thrown)} did not match the expected error`,
            operator, actual: thrown, expected,
        })
    }
}

// The `[filter, message]` tail doesNotThrow and doesNotReject take alike.
// The filter is a RegExp or a function only.
export interface Filtering {
    filter: Filter | undefined
    note: string | Error | undefined
}

export const readFilter = (expected?: Filter | string, message?: string | Error): Filtering => {
    const messageOnly = "string" === typeof expected
    const filter = messageOnly ? undefined : expected as Filter | undefined
    const note = messageOnly ? expected as string : message
    if (filter != null && !(filter instanceof RegExp || "function" === typeof filter)) throw invalid()
    return {filter, note}
}

// The verdict doesNotThrow and doesNotReject share: an exception the
// filter does not match is not this assertion's concern and passes
// through untouched.
export const expectNoError = (caught: Outcome, {filter, note}: Filtering, operator: "doesNotThrow" | "doesNotReject"): void => {
    if (caught == null) return
    const {thrown} = caught
    if (filter != null && !matches(thrown, filter)) throw thrown

    if (isError(note)) throw note
    throw new AssertionError({
        message: note ?? `expected not to ${VERB[operator]}, got: ${stringify(thrown)}`,
        operator, actual: thrown,
    })
}

// --- the synchronous pair ------------------------------------------------

// `throws(block, [expected], [message])`.
export const throws = (block: () => unknown, ...rest: [expected?: Predicate | string, message?: string | Error]): void => {
    if ("function" !== typeof block) throw invalid()
    const expectation = readExpectation(rest)
    expectError(attempt(block), expectation, "throws")
}

// `doesNotThrow(block, [filter], [message])`.
export const doesNotThrow = (block: () => unknown, expected?: Filter | string, message?: string | Error): void => {
    if ("function" !== typeof block) throw invalid()
    const filtering = readFilter(expected, message)
    expectNoError(attempt(block), filtering, "doesNotThrow")
}
