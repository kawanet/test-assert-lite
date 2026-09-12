import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {createTAL, reporter} from "../index.ts"
import type {Emit} from "../test-utils/format.ts"
import {formatEvents} from "../test-utils/format.ts"

const TITLE = "reporter/spec.test.ts"

// Scaffolding to drive spec() on its own, collecting what it writes.
const render = (send: (emit: Emit) => Promise<void>): Promise<string> =>
    formatEvents(reporter.spec({colors: false}), send)

const pass = (name: string, extra: object = {}) => ({
    name, nesting: 0, testNumber: 1,
    details: {duration_ms: 1, type: "test" as const}, ...extra,
})

describe(TITLE, () => {
    it("enables default colors only for a TTY", async () => {
        if ("undefined" === typeof process) return
        const stdout = process.stdout as {isTTY?: boolean}
        const descriptor = Object.getOwnPropertyDescriptor(stdout, "isTTY")
        const previousNoColor = process.env.NO_COLOR
        const previousDisabled = process.env.NODE_DISABLE_COLORS
        try {
            delete process.env.NO_COLOR
            delete process.env.NODE_DISABLE_COLORS
            Object.defineProperty(stdout, "isTTY", {configurable: true, value: true})

            const local = createTAL()
            const lines: string[] = []
            local.reporter.output(text => {
                lines.push(text)
            })
            local.it("colored", () => undefined)
            await local.run()

            assert.match(lines.join(""), /\u001b\[32m/)
        } finally {
            if (descriptor) Object.defineProperty(stdout, "isTTY", descriptor)
            else delete stdout.isTTY
            if (previousNoColor == null) delete process.env.NO_COLOR
            else process.env.NO_COLOR = previousNoColor
            if (previousDisabled == null) delete process.env.NODE_DISABLE_COLORS
            else process.env.NODE_DISABLE_COLORS = previousDisabled
        }
    })

    it("disables default colors outside a Node TTY", async () => {
        if ("undefined" !== typeof process && process.stdout.isTTY) return
        const local = createTAL()
        const lines: string[] = []
        local.reporter.output(text => {
            lines.push(text)
        })
        local.it("plain", () => undefined)
        await local.run()

        assert.equal(lines.join("").includes("\u001b["), false)
    })

    it("renders a passing test", async () => {
        const out = await render(emit => emit("test:pass", pass("ok one")))

        assert.match(out, /✔ ok one \(1\.000ms\)/)
    })

    it("renders a failing test and repeats it at the end", async () => {
        const out = await render(emit => emit("test:fail", {
            ...pass("bad one"),
            details: {duration_ms: 2, type: "test", error: new Error("boom")},
        }))

        assert.match(out, /✖ bad one/)
        assert.match(out, /failing tests:/)
        assert.match(out, /boom/)
    })

    it("marks a skipped test with its reason", async () => {
        const out = await render(emit => emit("test:pass", pass("skipped one", {skip: "why"})))

        assert.match(out, /﹣ skipped one .* # why/)
    })

    it("turns test:start into a suite heading", async () => {
        const out = await render(async emit => {
            await emit("test:start", {name: "S", nesting: 0})
            await emit("test:start", {name: "child", nesting: 1})
            await emit("test:pass", {...pass("child"), nesting: 1})
        })

        assert.match(out, /▶ S\n {2}✔ child/)
    })

    it("renders a diagnostic with its level", async () => {
        const out = await render(emit => emit("test:diagnostic", {
            message: "hello", nesting: 0, level: "info",
        }))

        assert.match(out, /ℹ hello/)
    })

    // emit() accepts any type, and an unknown one used to reach the branch
    // that reads details, where it crashed.
    it("ignores an event type it does not know", async () => {
        const out = await render(async emit => {
            await emit("my:custom:event", {hello: "world"} as never)
            await emit("test:pass", pass("still rendered"))
        })

        assert.match(out, /✔ still rendered/)
        assert.equal(/hello|world/.test(out), false)
    })

    // node:test's spec leaves out a suite that failed only through its children.
    it("keeps a suite failed by its children out of the failing list", async () => {
        const subtestsFailed = Object.assign(new Error("1 subtest failed"), {code: "ERR_TEST_FAILURE", failureType: "subtestsFailed"})
        const out = await render(async emit => {
            await emit("test:fail", {...pass("bad"), nesting: 1, details: {duration_ms: 1, type: "test", error: new Error("boom")}})
            await emit("test:fail", {...pass("S"), details: {duration_ms: 2, type: "suite", error: subtestsFailed}})
        })

        assert.match(out, /✖ S \(2\.000ms\)/)
        assert.equal(out.match(/✖ S/g)?.length, 1)
        assert.equal(out.match(/✖ bad/g)?.length, 2)
    })

    // Reused under node --test the events carry node's wrapper, whose cause
    // is the real error, or a plain string for a timeout or a cancellation.
    it("unwraps node:test's ERR_TEST_FAILURE wrapper", async () => {
        const wrap = (cause: unknown): Error => Object.assign(
            new Error(cause instanceof Error ? cause.message : String(cause)),
            {code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause},
        )
        const out = await render(async emit => {
            await emit("test:fail", {...pass("wrapped"), details: {duration_ms: 1, type: "test", error: wrap(new TypeError("inner"))}})
            await emit("test:fail", {...pass("timed"), details: {duration_ms: 1, type: "test", error: wrap("test timed out after 20ms")}})
        })

        assert.match(out, /TypeError: inner/)
        assert.equal(/ERR_TEST_FAILURE/.test(out), false)
        assert.match(out, /✖ timed \(1\.000ms\)\n {2}test timed out after 20ms/)
    })

    it("marks a todo test with its reason, and a failed todo as a warning", async () => {
        const out = await render(async emit => {
            await emit("test:pass", {...pass("todo one"), todo: "later"})
            await emit("test:fail", {...pass("todo two"), todo: true, details: {duration_ms: 1, type: "test", error: new Error("boom")}})
        })

        assert.match(out, /✔ todo one .* # later/)
        assert.match(out, /⚠ todo two .* # TODO/)
    })

    // node:test emits a summary per file, with `file`, and one for the run
    // without it. The list waits for the latter, as in node's own spec.
    it("lists the failures once, after the run's summary, not per file", async () => {
        const summary = {counts: {tests: 1, suites: 0, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0}, duration_ms: 1, success: false}
        const perFile = {...summary, file: "a.test.mjs"}
        const out = await render(async emit => {
            await emit("test:fail", {...pass("first"), details: {duration_ms: 1, type: "test", error: new Error("one")}})
            await emit("test:summary", perFile)
            await emit("test:fail", {...pass("second"), details: {duration_ms: 1, type: "test", error: new Error("two")}})
            await emit("test:summary", perFile)
        })

        assert.equal(out.split("failing tests:").length - 1, 1)
        assert.match(out, /failing tests:\n\n✖ first \(1\.000ms\)\n {2}Error: one[\s\S]*\n\n✖ second \(1\.000ms\)\n {2}Error: two/)
    })

    it("renders a skipped suite", async () => {
        const out = await render(emit => emit("test:pass", {...pass("S"), skip: true, details: {duration_ms: 1, type: "suite"}}))

        assert.match(out, /﹣ S \(1\.000ms\) # SKIP/)
    })

    // The whole shape as node:test's spec prints it for a suite whose before
    // hook failed: heading, cancelled child, the suite line, then the list.
    it("renders a cancelled suite like node:test", async () => {
        const local = createTAL()
        const lines: string[] = []
        local.reporter.format(local.reporter.spec({colors: false}))
        local.reporter.output(text => {
            lines.push(text)
        })
        local.describe("S", () => {
            local.before(() => {
                throw new Error("setup")
            })
            local.it("a", () => undefined)
        })
        await local.run()

        const out = lines.join("").replace(/\(\d+\.\d{3}ms\)/g, "(ms)")
        assert.match(out, /^▶ S\n {2}✖ a \(ms\)\n✖ S \(ms\)\n/)
        assert.match(out, /✖ failing tests:\n\n✖ a \(ms\)\n {2}test did not finish before its parent and was cancelled\n\n✖ S \(ms\)\n {2}Error: setup/)
    })

    // node:test's spec repeats the result line in the list, so a failure
    // that carries a skip keeps its skip symbol and note there too.
    it("lists a skipped failure with the skip symbol", async () => {
        const out = await render(emit => emit("test:fail", {
            ...pass("skipped then failed"), skip: "why",
            details: {duration_ms: 1, type: "test", error: new Error("boom")},
        }))

        assert.match(out, /failing tests:\n\n﹣ skipped then failed \(1\.000ms\) # why\n {2}Error: boom/)
        assert.equal(/✖ skipped then failed/.test(out), false)
    })
})
