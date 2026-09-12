import {type Inspect, getter, slotted} from "./inspect.ts"

// has() (SameValueZero) clears out primitives and same-reference elements
// in O(1) each; only what still needs a real deep comparison - normally
// nothing, for a Set of primitives - reaches the O(n^2) match below.
export const inspectSet: Inspect<Set<unknown>> = {
    is: slotted(Set, "[object Set]", getter(Set.prototype, "size")),
    eq: (left, right, deep) => {
        if (left.size !== right.size) return false
        const leftoverB = new Set(right)
        const leftoverA = [...left].filter(av => !leftoverB.delete(av))
        const remaining = [...leftoverB]
        return leftoverA.every(av => {
            const i = remaining.findIndex(bv => deep(av, bv))
            if (i < 0) return false
            remaining.splice(i, 1)
            return true
        })
    },
}

export const inspectMap: Inspect<Map<unknown, unknown>> = {
    is: slotted(Map, "[object Map]", getter(Map.prototype, "size")),
    eq: (left, right, deep) => {
        if (left.size !== right.size) return false
        const leftoverB = new Map(right)
        const leftoverA = [...left].filter(([ak, av]) => {
            if (!leftoverB.has(ak) || !Object.is(leftoverB.get(ak), av)) return true
            leftoverB.delete(ak)
            return false
        })
        const remaining = [...leftoverB]
        return leftoverA.every(([ak, av]) => {
            const i = remaining.findIndex(([bk, bv]) => deep(ak, bk) && deep(av, bv))
            if (i < 0) return false
            remaining.splice(i, 1)
            return true
        })
    },
}
