import {isError} from "../../common/is-error.ts"

// The recursion into a member, with the comparison's own state (strict or
// loose, the cycle stamps) already closed over, so no Inspect needs to
// know how the walk keeps it.
export type DeepEqual = (a: unknown, b: unknown) => boolean

// One kind of value: how it is recognised, then what it compares of its
// own, with loose given only where it differs from strict. eq answers
// false when that part differs; true or null (nothing of its own) both
// leave the walk over the own enumerable properties to follow, as in node.
export interface Inspect<T extends object> {
    is(v: object, tag: string): v is T
    eq(a: T, b: T, deep: DeepEqual): boolean | null
    loose?(a: T, b: T, deep: DeepEqual): boolean | null
}

type IsKind<T extends object> = (v: object, tag: string) => v is T

// Settled by what cannot be imitated: the internal slot an intrinsic
// reads, which throws on any other receiver. It is asked only of a
// candidate - a same-realm instance (instanceof, so a masked tag cannot
// hide it) or one showing the kind's tag (another realm's instance).
export const slotted = <T extends object>(ctor: Function | undefined, tag: string, intrinsic: (this: never) => unknown): IsKind<T> =>
    (v, seen): v is T => {
        if (!((ctor != null && v instanceof ctor) || seen === tag)) return false
        try {
            intrinsic.call(v as never)
            return true
        } catch {
            return false
        }
    }

export const getter = (proto: object, name: string): (this: never) => unknown =>
    Object.getOwnPropertyDescriptor(proto, name)!.get as (this: never) => unknown

// For a global this environment lacks: nothing can carry its tag either.
export const absent = <T extends object>(): IsKind<T> => (_v): _v is T => false

// The tag alone decides where no slot is reachable (Error, Arguments, a
// plain object).
const tagged = <T extends object>(tag: string): IsKind<T> => (_v, seen): _v is T => seen === tag

const regExpSource = getter(RegExp.prototype, "source")
const regExpFlags = getter(RegExp.prototype, "flags")

export const inspectError: Inspect<Error> = {
    is: isError,
    eq: (a, b, deep) => {
        const left = a as Error & {cause?: unknown, errors?: unknown}
        const right = b as Error & {cause?: unknown, errors?: unknown}
        if (left.name !== right.name || left.message !== right.message) return false
        if (("cause" in left) !== ("cause" in right)) return false
        if ("cause" in left && !deep(left.cause, right.cause)) return false
        // Checked by property name, not gated on AggregateError: node does
        // the same for any Error that happens to carry one.
        if (("errors" in left) !== ("errors" in right)) return false
        return !("errors" in left) || deep(left.errors, right.errors)
    },
}

export const inspectURL: Inspect<URL> = {
    is: "undefined" !== typeof URL ? slotted(URL, "[object URL]", getter(URL.prototype, "href")) : absent(),
    eq: (a, b) => a.href === b.href,
}

// Read through the intrinsics: an own property of the same name must not
// be able to fool the comparison.
export const inspectDate: Inspect<Date> = {
    is: slotted(Date, "[object Date]", Date.prototype.getTime),
    eq: (a, b) => Object.is(Date.prototype.getTime.call(a), Date.prototype.getTime.call(b)),
}

// lastIndex is own but non-enumerable, so it needs an explicit check.
export const inspectRegExp: Inspect<RegExp> = {
    is: slotted(RegExp, "[object RegExp]", regExpSource),
    eq: (a, b) =>
        regExpSource.call(a as never) === regExpSource.call(b as never) &&
        regExpFlags.call(a as never) === regExpFlags.call(b as never) &&
        a.lastIndex === b.lastIndex,
}

// Boolean and Number wrap a primitive no own key exposes; String's
// characters are own enumerable indices already, so for it this only adds
// the value check the walk would not make on its own.
export const inspectBoolean: Inspect<Boolean> = {
    is: slotted(Boolean, "[object Boolean]", Boolean.prototype.valueOf),
    eq: (a, b) => Object.is(Boolean.prototype.valueOf.call(a), Boolean.prototype.valueOf.call(b)),
}

export const inspectNumber: Inspect<Number> = {
    is: slotted(Number, "[object Number]", Number.prototype.valueOf),
    eq: (a, b) => Object.is(Number.prototype.valueOf.call(a), Number.prototype.valueOf.call(b)),
}

export const inspectString: Inspect<String> = {
    is: slotted(String, "[object String]", String.prototype.valueOf),
    eq: (a, b) => String.prototype.valueOf.call(a) === String.prototype.valueOf.call(b),
}

// eq touches the global only when called, which never happens where the
// global is missing: is() has said no to everything by then.
export const inspectBigInt: Inspect<BigInt> = {
    is: "undefined" !== typeof BigInt ? slotted(BigInt, "[object BigInt]", BigInt.prototype.valueOf) : absent(),
    eq: (a, b) => Object.is(BigInt.prototype.valueOf.call(a), BigInt.prototype.valueOf.call(b)),
}

// length is not enumerable, so the walk would miss it.
export const inspectArray: Inspect<unknown[]> = {
    is: Array.isArray,
    eq: (a, b) => a.length === b.length,
}

export const inspectArguments: Inspect<IArguments> = {
    is: tagged("[object Arguments]"),
    eq: (a, b) => a.length === b.length,
}

// Nothing outside its own enumerable properties: straight to the walk.
export const inspectObject: Inspect<object> = {
    is: tagged("[object Object]"),
    eq: () => null,
}
