import {type Inspect, absent, getter, slotted} from "./inspect.ts"

const sameElements = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

interface ByteRange {
    buffer: ArrayBufferLike
    byteOffset: number
    byteLength: number
}

// Read through the intrinsic accessor rather than a's own byteLength/
// byteOffset/buffer: a DataView or typed array subclass could otherwise
// override one of those to make sameBytes() below see the wrong range.
const byteRangeOf = <T extends object>(proto: object) => {
    const byteLength = Object.getOwnPropertyDescriptor(proto, "byteLength")!.get as (this: T) => number
    const byteOffset = Object.getOwnPropertyDescriptor(proto, "byteOffset")!.get as (this: T) => number
    const buffer = Object.getOwnPropertyDescriptor(proto, "buffer")!.get as (this: T) => ArrayBufferLike
    return {
        // Probes `buffer`, not byteLength/byteOffset: unlike those, it never
        // checks attachment, so a detached DataView still counts as one
        // rather than a spoofed non-DataView - instanceof and the tag can
        // both be lied about, but this accessor's own slot check can't.
        is: (v: object): v is T => {
            try {
                buffer.call(v as T)
                return true
            } catch {
                return false
            }
        },
        read: (v: T): ByteRange => ({
            buffer: buffer.call(v),
            byteOffset: byteOffset.call(v),
            byteLength: byteLength.call(v),
        }),
    }
}

const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as object
const dataView = byteRangeOf<DataView>(DataView.prototype)
const typedArray = byteRangeOf<ArrayBufferView>(typedArrayProto)

// Same reasoning as byteRangeOf: the element count comes from the
// intrinsic accessor, not from a `length` the instance could override.
export const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayProto, "length")!.get as (this: ArrayBufferView) => number

// Exact for any binary content, unlike Object.is, which treats every NaN
// payload as the same value. Falls back to comparing every byte when the
// two sides don't share a 4-byte alignment phase, since no 32-bit read
// could then land on both at once.
const deepEqualTypedArrays = (a: ByteRange, b: ByteRange): boolean => {
    if (a.byteLength !== b.byteLength) return false
    const length = a.byteLength

    // Nothing to read for an empty range, so return before touching the
    // buffer at all: even a zero-length view throws when constructed over
    // one that's detached, though there would be no bytes to compare anyway.
    if (length === 0) return true

    const phase = a.byteOffset % 4
    const lead = phase === b.byteOffset % 4 ? Math.min(length, (4 - phase) % 4) : length

    if (lead && !sameElements(new Uint8Array(a.buffer, a.byteOffset, lead), new Uint8Array(b.buffer, b.byteOffset, lead))) {
        return false
    }

    const bulk = Math.floor((length - lead) / 4)
    if (bulk && !sameElements(
        new Uint32Array(a.buffer, a.byteOffset + lead, bulk),
        new Uint32Array(b.buffer, b.byteOffset + lead, bulk),
    )) return false

    const tailAt = lead + bulk * 4
    if (length === tailAt) return true

    return sameElements(
        new Uint8Array(a.buffer, a.byteOffset + tailAt, length - tailAt),
        new Uint8Array(b.buffer, b.byteOffset + tailAt, length - tailAt),
    )
}

// ArrayBuffer.isView() answers for the typed arrays and DataView together
// without a throw, so nothing else ever reaches the brand check behind it.
const isDataView = (v: object): v is DataView => ArrayBuffer.isView(v) && dataView.is(v)
const isTypedArray = (v: object): v is ArrayBufferView => ArrayBuffer.isView(v) && typedArray.is(v)

// Tag rather than instanceof SharedArrayBuffer: that global may
// not exist in every environment, while nothing could carry
// this tag there either, so the check is safe either way.
const sameArrayBuffer = (a: ArrayBufferLike, b: ArrayBufferLike) => {
    return deepEqualTypedArrays(typedArray.read(new Uint8Array(a)), typedArray.read(new Uint8Array(b)))
}

// Neither instanceof DataView (fails cross-realm) nor the tag
// (a typed array can spoof Symbol.toStringTag to claim it too)
// would be safe here - see the brand-check comment on byteRangeOf.
const sameDataView = (a: DataView, b: DataView) => {
    return deepEqualTypedArrays(dataView.read(a), dataView.read(b))
}

// Brand-checked on both sides: the tag alone can be shared by a
// plain object with no typed-array slots, which read() would
// throw on. Covers the indices only; anything attached beyond
// them is left to the caller's own-key walk.
const sameTypedArray = (a: ArrayBufferView, b: ArrayBufferView) => {
    return deepEqualTypedArrays(typedArray.read(a), typedArray.read(b))
}

export const inspectArrayBuffer: Inspect<ArrayBuffer> = {
    is: slotted(ArrayBuffer, "[object ArrayBuffer]", getter(ArrayBuffer.prototype, "byteLength")),
    eq: sameArrayBuffer,
}

export const inspectSharedArrayBuffer: Inspect<SharedArrayBuffer> = {
    is: "undefined" !== typeof SharedArrayBuffer
        ? slotted(SharedArrayBuffer, "[object SharedArrayBuffer]", getter(SharedArrayBuffer.prototype, "byteLength"))
        : absent(),
    eq: sameArrayBuffer,
}

export const inspectDataView: Inspect<DataView> = {
    is: isDataView,
    eq: sameDataView,
}

// The loose typed array comparison: the elements are compared by value
// through the walk that follows, so +0 meets -0 and every NaN meets every
// other, and only the length is settled here - through the intrinsic, as
// the bytes are, so a subclass cannot report a length of its own.
export const inspectArrayBufferView: Inspect<ArrayBufferView> = {
    is: isTypedArray,
    eq: sameTypedArray,
    loose: (a, b) => typedArrayLength.call(a) === typedArrayLength.call(b),
}
