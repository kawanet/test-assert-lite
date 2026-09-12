import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {createTAL, reporter} from "../index.ts"
import type {Emit} from "../test-utils/format.ts"
import {formatEvents} from "../test-utils/format.ts"

const TITLE = "reporter/tap.test.ts"

// Scaffolding to drive tap() on its own, collecting what it writes.
const render = (send: (emit: Emit) => Promise<void>): Promise<string> =>
    formatEvents(reporter.tap(), send)

const pass = (name: string, extra: object = {}) => ({
    name, nesting: 0, testNumber: 1,
    details: {duration_ms: 1, type: "test" as const}, ...extra,
})

describe(TITLE, () => {
    it("starts with the TAP version line", async () => {
        const out = await render(emit => emit("test:pass", pass("ok one")))

        assert.match(out, /^TAP version 13\n/)
    })

    it("renders a passing test", async () => {
        const out = await render(emit => emit("test:pass", pass("ok one")))

        assert.match(out, /^ok 1 - ok one$/m)
    })

    it("renders a failing test with its error as comment lines", async () => {
        const out = await render(emit => emit("test:fail", {
            ...pass("bad one"),
            details: {duration_ms: 2, type: "test", error: new Error("boom")},
        }))

        assert.match(out, /^not ok 1 - bad one$/m)
        assert.match(out, /^# Error: boom$/m)
    })

    it("marks a skipped test with a bare SKIP directive", async () => {
        const out = await render(emit => emit("test:pass", pass("skipped one", {skip: true})))

        assert.match(out, /^ok 1 - skipped one # SKIP$/m)
    })

    it("marks a todo test with a TODO directive", async () => {
        const out = await render(async emit => {
            await emit("test:pass", {...pass("todo one"), todo: true})
            await emit("test:fail", {...pass("todo two"), todo: "later", details: {duration_ms: 1, type: "test", error: new Error("boom")}})
        })

        assert.match(out, /^ok 1 - todo one # TODO$/m)
        assert.match(out, /^not ok 2 - todo two # TODO later$/m)
    })

    it("marks a skipped test with its reason", async () => {
        const out = await render(emit => emit("test:pass", pass("skipped one", {skip: "why"})))

        assert.match(out, /^ok 1 - skipped one # SKIP why$/m)
    })

    // A skip called from a body that then throws is counted as skipped, but
    // the point itself still fails: node's own TAP output does the same,
    // and the diagnostic must survive so the failure is not silent.
    it("keeps the not ok verdict and diagnostic for a skip that then fails", async () => {
        const out = await render(emit => emit("test:fail", {
            ...pass("skip then throw", {skip: "skipping anyway"}),
            details: {duration_ms: 1, type: "test", error: new Error("boom after skip")},
        }))

        assert.match(out, /^not ok 1 - skip then throw # SKIP skipping anyway$/m)
        assert.match(out, /^# Error: boom after skip$/m)
    })

    it("escapes # and newlines in a test name", async () => {
        const out = await render(emit => emit("test:pass", pass("a # b\nc")))

        assert.match(out, /^ok 1 - a \\# b\\nc$/m)
    })

    it("escapes # and newlines in a skip reason", async () => {
        const out = await render(emit => emit("test:pass", pass("s", {skip: "why # not\nhere"})))

        assert.match(out, /^ok 1 - s # SKIP why \\# not\\nhere$/m)
    })

    it("turns test:start into a suite comment", async () => {
        const out = await render(async emit => {
            await emit("test:start", {name: "S", nesting: 0})
            await emit("test:start", {name: "child", nesting: 1})
            await emit("test:pass", {...pass("child"), nesting: 1})
        })

        assert.match(out, /^# S\nok 1 - child$/m)
    })

    it("ignores an event type it does not know", async () => {
        const out = await render(async emit => {
            await emit("my:custom:event", {hello: "world"} as never)
            await emit("test:pass", pass("still rendered"))
        })

        assert.match(out, /^ok 1 - still rendered$/m)
        assert.equal(/hello|world/.test(out), false)
    })

    // A suite that fails only through its children still gets its own
    // point in TAP: unlike spec()/html(), there is no separate end-of-run
    // list to defer it to, so nothing here needs isSubtestsFailed().
    it("gives a suite rollup its own point instead of dropping it", async () => {
        const subtestsFailed = Object.assign(new Error("1 subtest failed"), {code: "ERR_TEST_FAILURE", failureType: "subtestsFailed"})
        const out = await render(async emit => {
            await emit("test:fail", {...pass("bad"), nesting: 1, details: {duration_ms: 1, type: "test", error: new Error("boom")}})
            await emit("test:fail", {...pass("S"), details: {duration_ms: 2, type: "suite", error: subtestsFailed}})
        })

        assert.match(out, /^not ok 1 - bad$/m)
        assert.match(out, /^not ok 2 - S$/m)
        assert.match(out, /^# 1 subtest failed$/m)
    })

    // The bug an independent review caught in an earlier attempt: an
    // after hook failing with every child passing is the only report of
    // that failure, and dropping suite-typed events entirely lost it.
    it("reports a suite failure that has no failing child", async () => {
        const local = createTAL()
        const lines: string[] = []
        local.reporter.format(local.reporter.tap())
        local.reporter.output(text => {
            lines.push(text)
        })
        local.describe("outer", () => {
            local.it("child passes", () => undefined)
            local.after(() => {
                throw new Error("after hook exploded")
            })
        })
        const summary = await local.run()

        const out = lines.join("")
        assert.match(out, /^ok 1 - child passes$/m)
        assert.match(out, /^not ok 2 - outer$/m)
        assert.match(out, /^# Error: after hook exploded$/m)
        assert.equal(summary.success, false)
    })

    it("gives a skipped suite its own point", async () => {
        const out = await render(emit => emit("test:pass", {...pass("S"), skip: true, details: {duration_ms: 1, type: "suite"}}))

        assert.match(out, /^ok 1 - S # SKIP$/m)
    })

    // TAP has no standard summary syntax, so nothing here needs to
    // recognize or drop the harness's own end-of-run tally: every
    // diagnostic is forwarded exactly as spec()/html() forward it.
    it("forwards a test:diagnostic message as a comment line", async () => {
        const out = await render(emit => emit("test:diagnostic", {
            message: "tests 1", nesting: 0, level: "info",
        }))

        assert.match(out, /^# tests 1$/m)
    })

    it("plans the exact count of points emitted", async () => {
        const out = await render(async emit => {
            await emit("test:pass", pass("a"))
            await emit("test:pass", pass("b"))
            await emit("test:fail", {...pass("c"), details: {duration_ms: 1, type: "test", error: new Error("x")}})
        })

        assert.match(out, /^1\.\.3$/m)
    })
})
