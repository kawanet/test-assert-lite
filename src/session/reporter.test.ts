import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {TAL} from "test-assert-lite"
import {createTAL} from "../index.ts"
import {capture, names, summaryOf} from "../test-utils/capture.ts"

const TITLE = "session/reporter.test.ts"

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise
        return undefined
    } catch (error) {
        return error
    }
}

describe(TITLE, {timeout: 1000}, () => {

    it("rejects end() when the reporter throws", async () => {
        const local = createTAL()
        const failure = new Error("reporter failed")
        local.session.session({
            reporter: () => {
                throw failure
            },
        })
        local.test.it("one", () => undefined)

        assert.equal(await caught(local.session.end()), failure)
    })

    it("does not start the reporter when session() rejects", () => {
        const local = createTAL()
        let started = 0
        const tap = local.reporter.tap()
        const reporter: TAL.ReporterFn = source => {
            started++
            return tap(source)
        }

        assert.throws(() => local.session.session({uncaught: {} as any, reporter}))
        assert.equal(started, 0)
    })

    it("rejects end() when async reporter work rejects", async () => {
        const local = createTAL()
        const failure = new Error("async reporter failed")
        local.session.session({
            reporter: async function* (source) {
                for await (const _event of source) throw failure
            },
        })
        local.test.it("one", () => undefined)

        assert.equal(await caught(local.session.end()), failure)
    })

    it("rejects end() when the reporter throws after the last event", async () => {
        const local = createTAL()
        const failure = new Error("reporter failed at the end")
        local.session.session({
            reporter: async function* (source) {
                for await (const _event of source) continue
                throw failure
            },
        })
        local.test.it("one", () => undefined)

        assert.equal(await caught(local.session.end()), failure)
    })

    // The failure fails end() and the cleanups say nothing more. Under a
    // CLI, a line from a cleanup would reach it as stderr.
    it("reports a reporter failure once", async () => {
        const local = createTAL()
        const failure = new Error("reporter failed")
        const posts: string[] = []
        local.session.session({
            bridge: local.session.bridge(async path => void posts.push(path)),
            output: () => undefined,
            reporter: async function* (source) {
                for await (const _event of source) throw failure
            },
        })
        local.test.it("one", () => undefined)

        assert.equal(await caught(local.session.end()), failure)
        assert.deepEqual(posts, ["send", "send"])
    })

    it("preserves an undefined reporter rejection reason", async () => {
        const local = createTAL()
        local.session.session({
            reporter: () => {
                throw undefined
            },
        })
        local.test.it("one", () => undefined)
        let rejected = false

        try {
            await local.session.end()
        } catch (error) {
            rejected = true
            assert.equal(error, undefined)
        }
        assert.equal(rejected, true)
    })

    it("rejects end() when sync or async output fails", async () => {
        for (const asyncOutput of [false, true]) {
            const local = createTAL()
            const failure = new Error(asyncOutput ? "async output failed" : "output failed")
            local.session.session({
                output: asyncOutput
                    ? async () => Promise.reject(failure)
                    : () => {
                        throw failure
                    },
            })
            local.test.it("one", () => undefined)

            assert.equal(await caught(local.session.end()), failure)
        }
    })

    it("rejects when a reporter ends before consuming its input", async () => {
        const local = createTAL()
        local.session.session({
            reporter: async function* () {
                yield "stopped\n"
            },
            output: () => undefined,
        })
        local.test.it("one", () => undefined)

        const error = await caught(local.session.end())
        assert.match(String(error), /reporter ended before its input/i)
    })

    it("rejects a manual iterator that returns after the summary without reading done", async () => {
        const local = createTAL()
        local.session.session({
            reporter: async function* (source) {
                const iterator = source[Symbol.asyncIterator]()
                for (;;) {
                    const result = await iterator.next()
                    if (result.done || result.value.type === "test:summary") return
                }
            },
            output: () => undefined,
        })
        local.test.it("one", () => undefined)

        const error = await caught(local.session.end())
        assert.match(String(error), /reporter ended before its input/i)
    })

    it("allows a manual iterator to finish by reading done", async () => {
        const local = createTAL()
        local.session.session({
            reporter: async function* (source) {
                const iterator = source[Symbol.asyncIterator]()
                while (!(await iterator.next()).done) {
                    // Reading until done is the reporter's completion contract.
                }
            },
            output: () => undefined,
        })
        local.test.it("one", () => undefined)

        const summary = await local.session.end()
        assert.equal(summary.success, true)
    })

    it("propagates output failure from a synchronous diagnostic()", async () => {
        const local = createTAL()
        const failure = new Error("diagnostic output failed")
        local.session.session({
            reporter: async function* (source) {
                for await (const event of source) {
                    if (event.type === "test:diagnostic") yield event.data.message
                }
            },
            output: text => {
                if (text === "from body") throw failure
            },
        })
        local.test.it("one", t => {
            t.diagnostic("from body")
        })

        assert.equal(await caught(local.session.end()), failure)
    })

    // end() closes the session, settings and all: the next run opens one of
    // its own, with the defaults unless session() is called again.
    it("a session ends with end(), and the next run opens another", async () => {
        const local = createTAL()
        const output: string[] = []
        const settings: NonNullable<Parameters<typeof local.session.session>[0]> = {
            reporter: async function* (source) {
                for await (const event of source) {
                    if (event.type === "test:pass") yield `${event.data.name}\n`
                }
            },
            output: text => {
                output.push(text)
            },
        }
        local.session.session(settings)
        local.test.it("first", () => undefined)
        await local.session.end()
        local.session.session(settings)
        local.test.it("second", () => undefined)
        await local.session.end()

        assert.equal(output.join(""), "first\nsecond\n")
    })

    // A test declared first opens the default session; session() then has
    // nothing to configure, and says so rather than take settings late.
    it("session() after a declaration throws", () => {
        const local = createTAL()
        local.test.it("first", () => undefined)

        assert.throws(() => local.session.session({output: () => undefined}), /before the first test is declared/)
    })

    it("session() twice throws until end() has closed the first", async () => {
        const local = createTAL()
        local.session.session({output: () => undefined})

        assert.throws(() => local.session.session({output: () => undefined}), /already open/)
        await local.session.end()
        local.session.session({output: () => undefined})
    })

    // end() alone opens the default session and closes it again.
    it("end() with nothing declared reports an empty run", async () => {
        const local = createTAL()
        const events = capture(local)
        const result = await local.session.end()

        assert.equal(result.success, true)
        assert.equal(summaryOf(events).counts.tests, 0)
    })

    it("a failed end() closes the session too, and the next run starts clean", async () => {
        const local = createTAL()
        const failure = new Error("reporter failed")
        local.session.session({
            reporter: () => {
                throw failure
            },
        })
        local.test.it("discarded", () => undefined)
        assert.equal(await caught(local.session.end()), failure)

        const events = capture(local)
        local.test.it("recovered", () => undefined)
        const result = await local.session.end()

        assert.equal(result.success, true)
        assert.deepEqual(names(events, "test:pass"), ["recovered"])
    })
})
