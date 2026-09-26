// The page's side of the channel, without a network: what the session
// posts, in what order, and with what verdict.

import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {TAL} from "test-assert-lite"
import {createTAL} from "../index.ts"

const TITLE = "session/client.test.ts"

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
    })

    it("gathers a burst of lines into one request per stream", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        for (let i = 0; i < 100; i++) bridge.stdout.write(`line ${i}\n`)
        await session.end()

        assert.deepEqual(logs[0], ["send", BEGIN])
        assert.equal(logs[1]?.[0], "stdout")
        const lines = logs[1]?.[1]?.split(/(?<=\n)(?=\S)/) ?? []
        assert.equal(lines.length, 100)
        assert.equal(lines.at(0), "line 0\n")
        assert.equal(lines.at(-1), "line 99\n")
        assert.deepEqual(logs[2], ["send", SUCCESS])
    })

    it("flushes on its own while the run goes on", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        bridge.stdout.write("early\n")
        await sleep(200)
        assert.deepEqual(logs[0], ["send", BEGIN])
        assert.deepEqual(logs[1], ["stdout", "early\n"])

        bridge.stdout.write("late\n")
        await session.end()
        assert.equal(logs.length, 4)
        assert.deepEqual(logs[2], ["stdout", "late\n"])
        assert.deepEqual(logs[3], ["send", SUCCESS])
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

        const lines = (logs[1]?.[1] ?? "").split("\n")
        assert.equal(lines[0], "as given")
    })

    it("text written before session() goes out once the session is open", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        bridge.stdout.write("early\n")
        bridge.stderr.write("warned\n")
        session.session({bridge, output})
        await session.end()

        assert.deepEqual(logs[0], ["stdout", "early\n"])
        assert.deepEqual(logs[1], ["stderr", "warned\n"])
        assert.deepEqual(logs[2], ["send", BEGIN])
        assert.deepEqual(logs[3], ["send", SUCCESS])
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

    it("text written after end() waits for the next session", async () => {
        const {session} = createTAL()
        const {logs, bridge, output} = testStub(session)
        session.session({bridge, output})
        await session.end()
        bridge.stdout.write("later\n")
        assert.equal(logs.length, 2)

        session.session({bridge, output})
        await session.end()
        assert.deepEqual(logs[2], ["stdout", "later\n"])
        assert.deepEqual(logs[3], ["send", BEGIN])
        assert.deepEqual(logs[4], ["send", SUCCESS])
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

        assert.deepEqual(logs[0], ["send", BEGIN])
        assert.deepEqual(logs[1], ["stdout", "a 1 b\ninfo\ndebug\n"])
        assert.equal(logs[2]?.[0], "stderr")
        const lines = (logs[2]?.[1] ?? "").split("\n")
        assert.equal(lines[0], "warned")
        assert.match(lines[1] ?? "", /^TypeError: typed/)
        assert.deepEqual(logs[3], ["send", SUCCESS])
    })
})
