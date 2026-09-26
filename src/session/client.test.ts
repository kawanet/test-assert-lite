// The page's side of the channel, without a network: what the session
// posts, in what order, and with what verdict.

import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {TAL} from "test-assert-lite"
import {createTAL} from "../index.ts"

const TITLE = "session/client.test.ts"

const NEWLINE = /(?<=\n)(?=\S)/

const testStub = (session: TAL.SessionAPI, fetch?: TAL.FetchLike) => {
    const logs: [string, string][] = []

    fetch ??= async (path, init) => {
        logs.push([path, init.body])
    }

    const bridge = session.connect({fetch})

    const output = () => undefined

    return {logs, bridge, output}
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const BEGIN = JSON.stringify({type: "session:begin"})
const SUCCESS = JSON.stringify({type: "session:end", data: {success: true}})
const FAILURE = JSON.stringify({type: "session:end", data: {success: false}})

describe(TITLE, {timeout: 1000}, () => {
    it("posts begin first, then the streams, then end, in order", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        bridge.stdout.write("one\n")
        bridge.stderr.write("warned\n")
        bridge.stdout.write("two\n")
        await session.end()

        assert.deepEqual(logs.shift(), ["send", BEGIN])
        assert.deepEqual(logs.shift(), ["stdout", "one\n"])
        assert.deepEqual(logs.shift(), ["stderr", "warned\n"])
        assert.deepEqual(logs.shift(), ["stdout", "two\n"])
        assert.deepEqual(logs.shift(), ["send", SUCCESS])
        assert.equal(logs.length, 0)
    })

    it("gathers a burst of lines into one request per stream", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        for (let i = 0; i < 100; i++) bridge.stdout.write(`line ${i}\n`)
        await session.end()

        assert.deepEqual(logs.shift(), ["send", BEGIN])
        const [type, body] = logs.shift()!
        assert.equal(type, "stdout")
        const lines = body.split(NEWLINE) ?? []
        assert.equal(lines.length, 100)
        assert.equal(lines.at(0), "line 0\n")
        assert.equal(lines.at(-1), "line 99\n")
        assert.deepEqual(logs.shift(), ["send", SUCCESS])
        assert.equal(logs.length, 0)
    })

    it("flushes on its own while the run goes on", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        bridge.stdout.write("early\n")
        await sleep(200)
        assert.deepEqual(logs.shift(), ["send", BEGIN])
        assert.deepEqual(logs.shift(), ["stdout", "early\n"])
        assert.equal(logs.length, 0)

        bridge.stdout.write("late\n")
        await session.end()
        assert.deepEqual(logs.shift(), ["stdout", "late\n"])
        assert.deepEqual(logs.shift(), ["send", SUCCESS])
        assert.equal(logs.length, 0)
    })

    it("sends the run's verdict: false once a test failed", async () => {
        const {session, test} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        test.it("fails", () => {
            throw new Error("no")
        })
        await session.end()
        assert.deepEqual(logs.at(-1), ["send", FAILURE])
    })

    it("sends text as given", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        bridge.stderr.write("as ")
        bridge.stderr.write("given\n")
        await session.end()

        assert.deepEqual(logs.shift(), ["send", BEGIN])
        assert.deepEqual(logs.shift(), ["stderr", "as given\n"]) // combined
        assert.deepEqual(logs.shift(), ["send", SUCCESS])
        assert.equal(logs.length, 0)
    })

    it("text written before session() goes out once the session is open", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        bridge.stdout.write("early\n")
        bridge.stderr.write("warned\n")
        session.session({bridge, output})
        await session.end()

        assert.deepEqual(logs.shift(), ["stdout", "early\n"])
        assert.deepEqual(logs.shift(), ["stderr", "warned\n"])
        assert.deepEqual(logs.shift(), ["send", BEGIN])
        assert.deepEqual(logs.shift(), ["send", SUCCESS])
        assert.equal(logs.length, 0)
    })

    it("does not reject when the fetch does", async () => {
        const {session} = createTAL()
        const {bridge, output} = testStub(session, async () => {
            throw new TypeError("fetch failed")
        })
        session.session({bridge, output})
        bridge.stdout.write("lost\n")
        bridge.stderr.write("still lost\n")
        assert.equal((await session.end()).success, true)
    })

    // A console of the test's own stands in for the page's.
    it("takes a console: log to stdout, error to stderr, a call a line, and gives it back at the end", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        const fake = {
            debug: (..._: unknown[]) => undefined,
            log: (..._: unknown[]) => undefined,
            info: (..._: unknown[]) => undefined,
            warn: (..._: unknown[]) => undefined,
            error: (..._: unknown[]) => undefined,
        }
        const {log, warn} = fake
        session.session({bridge, output, console: fake})
        assert.notEqual(fake.log, log)
        fake.log("a", 1, "b")
        fake.info("info")
        fake.debug("debug")
        fake.warn("warned")
        fake.error(new TypeError("typed"))
        await session.end()
        assert.equal(fake.log, log)
        assert.equal(fake.warn, warn)

        assert.deepEqual(logs.shift(), ["send", BEGIN])
        assert.deepEqual(logs.shift(), ["stdout", "a 1 b\ninfo\ndebug\n"])
        const [type, body] = logs.shift()!
        assert.equal(type, "stderr")
        const lines = body?.split(NEWLINE)
        assert.equal(lines.shift(), "warned\n")
        assert.match(lines.shift()!, /^TypeError: typed/)
        assert.deepEqual(logs.shift(), ["send", SUCCESS])
        assert.equal(logs.length, 0)
    })
})
