import {isError} from "../utils/is-error.ts"
import {stringify} from "../utils/stringify.ts"
import {AssertionError} from "./assertion-error.ts"
import {inspectMap, inspectSet} from "./inspect/collections.ts"
import {
    type DeepEqual,
    type Inspect,
    inspectArguments,
    inspectArray,
    inspectBigInt,
    inspectBoolean,
    inspectDate,
    inspectError,
    inspectNumber,
    inspectObject,
    inspectRegExp,
    inspectString,
    inspectURL,
} from "./inspect/inspect.ts"
import {
    inspectArrayBuffer,
    inspectArrayBufferView,
    inspectDataView,
    inspectSharedArrayBuffer,
    typedArrayLength,
} from "./inspect/typed-array.ts"

const toTag = (v: object): string => Object.prototype.toString.call(v)

// --- the table -----------------------------------------------------------

// Every value is sorted into one kind before anything is compared, and
// both sides must land on the same one. Order matters only where kinds
// overlap: an Error subclass carries the Error slot and nothing else.
const kinds: Inspect<object>[] = [
    inspectError,
    inspectURL,
    inspectDate,
    inspectRegExp,
    inspectBoolean,
    inspectNumber,
    inspectString,
    inspectBigInt,
    inspectMap,
    inspectSet,
    inspectArrayBuffer,
    inspectSharedArrayBuffer,
    inspectDataView,
    inspectArrayBufferView,
    inspectArray,
    inspectArguments,
    inspectObject,
]

// No kind is any value this has no comparison for: WeakMap, Promise, a
// class instance with its own tag. Only a shared reference is equal then,
// which the identity check before the kinds already answered.
const inspectOf = (v: object, tag: string): Inspect<object> | undefined => kinds.find(kind => kind.is(v, tag))

// --- the comparison ------------------------------------------------------

// Symbol keys are rare in practice, but cheap enough to walk alongside
// Object.keys() rather than carve out as a separate scope decision.
const ownKeys = (v: object, skip: number): PropertyKey[] =>
    [...Object.keys(v).slice(skip), ...Object.getOwnPropertySymbols(v).filter(s => Object.prototype.propertyIsEnumerable.call(v, s))]

// Stamps each (left, right) pair by the order it was first entered. A
// revisit is equal only if the right side carries the same stamp - the
// same pairing, not merely a same-shaped cycle of a different period.
interface Memo {
    left: WeakMap<object, number>
    right: WeakMap<object, number>
    position: number
    strict: boolean
    deep: DeepEqual
}

const isPrimitive = (v: unknown): boolean => v == null || "object" !== typeof v

// Two non-objects under the loose rules: ==, except that NaN equals
// itself, the way node's deepEqual (and its equal) treats it.
export const looseSame = (a: unknown, b: unknown): boolean => a == b || (Number.isNaN(a) && Number.isNaN(b))

// Strict is node's deepStrictEqual: Object.is for primitives, a shared
// prototype, own enumerable string and symbol keys. Loose is its deepEqual:
// == for primitives, the prototype ignored, symbol keys not walked. The
// kinds, what each kind compares of its own, and the key walk itself are
// shared by both.
const isDeepEqual = (a: unknown, b: unknown, memo: Memo): boolean => {
    if (Object.is(a, b)) return true
    if (a == null || b == null || "object" !== typeof a || "object" !== typeof b) {
        // An object never loosely equals a primitive either.
        return !memo.strict && isPrimitive(a) && isPrimitive(b) && looseSame(a, b)
    }
    if (memo.strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false

    // The tag first, as node does: it separates an Arguments object from
    // a plain object, or a lookalike from a real array, whatever their
    // prototypes. Then the kind, which each side settles for itself.
    const tagA = toTag(a)
    const tagB = toTag(b)
    if (tagA !== tagB) return false
    const kind = inspectOf(a, tagA)
    if (kind == null || kind !== inspectOf(b, tagB)) return false
    const same = memo.strict || kind.loose == null ? kind.eq : kind.loose

    // Stamped before recursing into anything below - including an Error's
    // cause chain - so a cycle reached through any path is still caught.
    // A revisit on either side alone is a cycle the other side lacks, so
    // it counts as a difference rather than being stamped afresh.
    const stamp = memo.left.get(a)
    if (stamp != null || memo.right.has(b)) return memo.right.get(b) === stamp
    const position = ++memo.position
    memo.left.set(a, position)
    memo.right.set(b, position)

    try {
        if (false === same(a, b, memo.deep)) return false

        // Under strict, own enumerable symbol keys count like string keys,
        // on a typed array or a boxed primitive as much as on plain data.
        // The one exception is a builtin that exposes engine-internal state
        // through such a symbol (observed on URL, Node 18.x vs 24.x).
        const symbolAware = memo.strict && kind !== inspectURL

        // A typed array's indices are settled by the bytes under strict, and
        // Object.keys() lists them first: only a property attached on top
        // is left to walk.
        const skip = kind === inspectArrayBufferView && memo.strict ? typedArrayLength.call(a as ArrayBufferView) : 0

        const other = b as Record<PropertyKey, unknown>
        const keysA = symbolAware ? ownKeys(a, skip) : Object.keys(a).slice(skip)
        const keysB = new Set(symbolAware ? ownKeys(b, skip) : Object.keys(b).slice(skip))
        return keysA.length === keysB.size &&
            keysA.every(key => keysB.has(key) && isDeepEqual((a as Record<PropertyKey, unknown>)[key], other[key], memo))
    } finally {
        memo.left.delete(a)
        memo.right.delete(b)
    }
}

const newMemo = (strict: boolean): Memo => {
    const memo: Memo = {left: new WeakMap(), right: new WeakMap(), position: 0, strict, deep: (a, b) => isDeepEqual(a, b, memo)}
    return memo
}

type DeepAssertion = (actual: unknown, expected: unknown, message?: string | Error) => void

// The flag is fixed here rather than taken per call, since node's own
// signatures have no room for it: one pair serves as deepStrictEqual /
// notDeepStrictEqual, the other as the loose deepEqual / notDeepEqual.
export const deepEqualPair = (strict: boolean): {deepEqual: DeepAssertion, notDeepEqual: DeepAssertion} => {
    const deepEqual: DeepAssertion = (actual, expected, message) => {
        if (isDeepEqual(actual, expected, newMemo(strict))) return
        if (isError(message)) throw message

        // Keep the values even when a message is given: without them there
        // is nothing to start debugging from.
        const detail = `expected ${stringify(expected)} to deep-equal ${stringify(actual)}`
        throw new AssertionError({
            message: message == null ? detail : `${message}\n\n${detail}`,
            actual, expected, operator: strict ? "deepStrictEqual" : "deepEqual",
        })
    }

    const notDeepEqual: DeepAssertion = (actual, expected, message) => {
        if (!isDeepEqual(actual, expected, newMemo(strict))) return
        if (isError(message)) throw message
        throw new AssertionError({
            message: message ?? `expected not to deep-equal ${stringify(expected)}`,
            actual, expected, operator: strict ? "notDeepStrictEqual" : "notDeepEqual",
        })
    }

    return {deepEqual, notDeepEqual}
}
