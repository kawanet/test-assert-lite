import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {createTAL, reporter} from "../index.ts"
import {formatEvents} from "../test-utils/format.ts"

const TITLE = "common/tester-error.test.ts"

// What the spec reporter prints for a test that failed with `error`.
// Typed as an Error, though a runner may hand over any thrown value.
const output = (error: unknown): Promise<string> => formatEvents(reporter.spec({colors: false}), emit =>
    emit("test:fail", {name: "bad", nesting: 0, testNumber: 1, details: {duration_ms: 1, type: "test", error: error as Error}}))

const withStack = (error: Error, stack: string | undefined): Error => Object.assign(error, {stack})

const count = (text: string, line: string): number => text.split(line).length - 1

// Runs a real test that throws `value`, and returns what the spec
// reporter prints. The one path a thrown non-Error value actually
// reaches: details.error is typed as Error, so testRunnerError() always
// wraps it before any reporter sees it - errorText() is never handed a
// raw 42 directly, only through this route.
const thrown = async (value: unknown): Promise<string> => {
    const local = createTAL()
    const lines: string[] = []
    local.reporter.format(local.reporter.spec({colors: false}))
    local.reporter.output(text => {
        lines.push(text)
    })
    local.it("bad", () => {
        throw value
    })
    await local.run()
    return lines.join("")
}

describe(TITLE, () => {
    it("opens with name and message, once", async () => {
        const out = await output(new Error("boom"))
        assert.match(out, /Error: boom/)
        assert.equal(count(out, "Error: boom"), 1)
    })

    it("keeps a stack that opens with name and message", async () => {
        const out = await output(withStack(new Error("boom"), "Error: boom\n    at fn (http://host/suite.mjs:12:3)"))
        assert.equal(count(out, "Error: boom"), 1)
    })

    it("keeps the code Node writes after the name", async () => {
        const out = await output(withStack(new Error("1 == 2"), "AssertionError [ERR_ASSERTION]: 1 == 2\n    at fn (http://host/suite.mjs:12:3)"))
        assert.equal(count(out, "AssertionError [ERR_ASSERTION]: 1 == 2"), 1)
    })

    it("keeps a name alone when the message is empty", async () => {
        const out = await output(withStack(new Error(), "Error\n    at fn (http://host/suite.mjs:12:3)"))
        assert.equal(count(out, "Error\n"), 1)
    })

    it("keeps a header with no frames after it", async () => {
        const out = await output(withStack(new Error(), "Error"))
        assert.equal(count(out, "Error"), 1)
    })

    it("writes the message alone when the name is empty", async () => {
        const out = await output(withStack(Object.assign(new Error("boom"), {name: ""}), "fn@http://host/suite.mjs:12:3"))
        assert.match(out, /boom/)
        assert.doesNotMatch(out, /: boom/)
    })

    it("adds nothing when the name and message are both empty", async () => {
        const out = await output(withStack(Object.assign(new Error(""), {name: ""}), "fn@http://host/suite.mjs:12:3"))
        assert.doesNotMatch(out, /\n\s*\n\s*fn@/)
    })

    it("prepends the bare name above frames only when the message is empty", async () => {
        const out = await output(withStack(new Error(), "fn@http://host/suite.mjs:12:3"))
        assert.match(out, /Error\n\s*fn@/)
    })

    it("keeps a message over several lines", async () => {
        const out = await output(withStack(new Error("l1\nl2"), "Error: l1\nl2\n    at fn (http://host/suite.mjs:12:3)"))
        assert.equal(count(out, "Error: l1"), 1)
    })

    // Safari and Firefox list the frames only, fn@url each.
    it("adds name and message above frames only", async () => {
        const out = await output(withStack(new RangeError("boom"), "fn@http://host/suite.mjs:12:3\n@http://host/suite.mjs:40:1"))
        assert.match(out, /RangeError: boom\n\s*fn@/)
    })

    it("adds them even when the first frame's function name starts like the error's", async () => {
        const out = await output(withStack(new Error("boom"), "ErrorHandler@http://host/suite.mjs:12:3"))
        assert.match(out, /Error: boom\n\s*ErrorHandler@/)
    })

    it("adds them even when the message is the first frame's function name", async () => {
        const out = await output(withStack(new Error("fn"), "fn@http://host/suite.mjs:12:3"))
        assert.match(out, /Error: fn\n\s*fn@/)
    })

    it("falls back to name and message without a stack", async () => {
        const out = await output(withStack(new TypeError("boom"), undefined))
        assert.match(out, /TypeError: boom/)
    })

    // node:test wraps a failure in ERR_TEST_FAILURE with the Error as cause.
    it("reads through a test failure wrapper to its cause", async () => {
        const cause = withStack(new Error("inner"), "fn@http://host/suite.mjs:12:3")
        const out = await output(Object.assign(new Error("outer"), {code: "ERR_TEST_FAILURE", cause}))
        assert.match(out, /Error: inner/)
        assert.doesNotMatch(out, /outer/)
    })

    // A thrown array is read through stringify(), not the default join
    // String() gives: the one shape that tells the two apart.
    it("prints a thrown non-Error value through stringify", async () => {
        const out = await thrown([1, 2, 3])
        assert.match(out, /\[1,2,3\]/)
        assert.doesNotMatch(out, /TesterError/)
    })

    // TAL wraps a thrown value that is not an Error, keeping it as the message.
    it("prints a thrown string as it is", async () => {
        assert.match(await thrown("thrown a string"), /thrown a string/)
    })

    // Neither is an Error, so String() alone decides this - the same on
    // every engine, unlike the stack-based cases above.
    it("prints a thrown primitive as it is", async () => {
        assert.match(await thrown(42), /^ {2}42$/m)
        assert.match(await thrown(undefined), /^ {2}undefined$/m)
    })
})
