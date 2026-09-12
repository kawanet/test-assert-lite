// An Error built in another realm - an iframe, a worker, a vm context - has
// a different constructor, so instanceof says no. The [[ErrorData]] slot
// survives the boundary and keeps the toString tag at "[object Error]", so
// check that too. A plain object shaped like an Error is still rejected.
export const isError = (value: unknown): value is Error =>
    value instanceof Error || ("object" === typeof value && "[object Error]" === Object.prototype.toString.call(value))
