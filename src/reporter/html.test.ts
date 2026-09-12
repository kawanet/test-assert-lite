import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {reporter} from "../index.ts"
import type {Emit} from "../test-utils/format.ts"
import {formatEvents} from "../test-utils/format.ts"

const TITLE = "reporter/html.test.ts"

const render = (send: (emit: Emit) => Promise<void>): Promise<string> =>
    formatEvents(reporter.html(), send)

const pass = (name: string, extra: object = {}) => ({
    name, nesting: 0, testNumber: 1,
    details: {duration_ms: 1, type: "test" as const}, ...extra,
})

describe(TITLE, () => {
    it("renders list items with status classes", async () => {
        const out = await render(async emit => {
            await emit("test:start", {name: "suite", nesting: 0})
            await emit("test:start", {name: "ok", nesting: 1})
            await emit("test:pass", {...pass("ok"), nesting: 1})
            await emit("test:pass", pass("later", {skip: "not now"}))
        })

        assert.match(out, /<div class="tal-r "><span class="tal-suite">▶ suite/)
        assert.match(out, /<div class="tal-r tal-i1"><span class="tal-pass">✔ ok/)
        assert.match(out, /<div class="tal-r "><span class="tal-skip">﹣ later</)
    })

    it("marks a todo test, and a failed todo as a warning", async () => {
        const out = await render(async emit => {
            await emit("test:pass", pass("todo one", {todo: "later"}))
            await emit("test:fail", {
                ...pass("todo two"), todo: true,
                details: {duration_ms: 1, type: "test", error: new Error("boom")},
            })
        })

        assert.match(out, /<span class="tal-pass">✔ todo one<\/span> <span class="tal-info">\(1\.000ms\)<\/span> # later/)
        assert.match(out, /<span class="tal-warn">⚠ todo two<\/span>/)
    })

    it("lists the failures once, after the run's summary, not per file", async () => {
        const summary = {counts: {tests: 1, suites: 0, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0}, duration_ms: 1, success: false}
        const perFile = {...summary, file: "a.test.mjs"}
        const out = await render(async emit => {
            await emit("test:fail", {...pass("first"), details: {duration_ms: 1, type: "test", error: new Error("one")}})
            await emit("test:summary", perFile)
            await emit("test:fail", {...pass("second"), details: {duration_ms: 1, type: "test", error: new Error("two")}})
            await emit("test:summary", summary)
            await emit("test:pass", pass("after"))
        })

        assert.equal(out.split("failing tests:").length - 1, 1)
        assert.match(out, /failing tests:.*✖ first.*✖ second/s)
        assert.ok(out.indexOf("failing tests:") < out.indexOf("✔ after"))
    })

    it("escapes text and failure details", async () => {
        const out = await render(async emit => {
            await emit("test:diagnostic", {message: `<&>"'`, nesting: 0, level: "warn"})
            await emit("test:fail", {
                ...pass("<broken>"),
                details: {duration_ms: 2, type: "test", error: new Error("bad <tag> & data")},
            })
        })

        assert.match(out, /&lt;&amp;&gt;&quot;&apos;/)
        assert.match(out, /&lt;broken&gt;/)
        assert.match(out, /bad &lt;tag&gt; &amp; data/)
        assert.equal(out.includes("<broken>"), false)
        assert.equal(out.includes("<tag>"), false)
    })

    it("escapes a diagnostic level used in an attribute", async () => {
        const out = await render(emit => emit("test:diagnostic", {
            message: "unsafe level", nesting: 0,
            level: `info" onclick="alert('x')` as never,
        }))

        assert.match(out, /tal-info&quot; onclick=&quot;alert\(&apos;x&apos;\)/)
        assert.equal(out.includes(`onclick="alert('x')"`), false)
    })

    it("renders diagnostics and omits parent-only failures from the failure list", async () => {
        const subtestsFailed = Object.assign(new Error("child failed"), {
            code: "ERR_TEST_FAILURE", failureType: "subtestsFailed",
        })
        const out = await render(async emit => {
            await emit("test:diagnostic", {message: "notice", nesting: 1, level: "info"})
            await emit("test:fail", {
                ...pass("suite"), details: {duration_ms: 2, type: "suite", error: subtestsFailed},
            })
        })

        assert.match(out, /tal-info">ℹ notice/)
        assert.equal(out.match(/✖ suite/g)?.length, 1)
        assert.equal(out.includes("failing tests:"), false)
    })
})
