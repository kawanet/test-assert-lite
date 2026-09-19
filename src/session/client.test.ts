import {strict as assert} from "node:assert"
import {after, before, describe, it} from "node:test"
import {createTAL} from "../index.ts"

const TITLE = "session/client.test.ts"

// The CLI's side without a network: fetch() is all the session sends with,
// so a stand-in takes what goes to the run below and keeps each request's
// path and body in arrival order, and refuses what goes to the run that
// is gone. Anything else goes on to the real fetch(): in a browser, the
// page's own session reports this very run through the same function.
const RUN = "http://127.0.0.1:1/@tal/run/abc/"
const GONE = "http://127.0.0.1:1/@tal/run/gone/"
const seen: {path: string, body: string}[] = []
const real = globalThis.fetch

const stub: typeof fetch = (input, init) => {
    const url = String(input)
    if (url.startsWith(GONE)) return Promise.reject(new TypeError("fetch failed"))
    if (!url.startsWith(RUN)) return real.call(globalThis, input, init)
    seen.push({path: new URL(url).pathname, body: String(init?.body ?? "")})
    return Promise.resolve(new Response(null, {status: 204}))
}

// A harness per session, since a session stays open until its end(); the
// report itself is kept off the channel, so what is seen is what is sent.
const connect = (base: string | URL) => {
    const local = createTAL()
    local.session.session({base, output: () => undefined})
    return {...local.session, it: local.test.it}
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe(TITLE, () => {
    before(() => {
        globalThis.fetch = stub
    })

    after(() => {
        globalThis.fetch = real
    })

    it("posts begin first, then the streams, then end, in order", async () => {
        seen.length = 0
        const client = connect(RUN)
        client.stdout.write("one\n")
        client.stderr.write("warned\n")
        client.stdout.write("two\n")
        await client.end()
        assert.deepEqual(seen.map(({path}) => path), [
            "/@tal/run/abc/begin",
            "/@tal/run/abc/stdout",
            "/@tal/run/abc/stderr",
            "/@tal/run/abc/end",
        ])
        assert.equal(seen[1]?.body, "one\ntwo\n")
        assert.equal(seen[2]?.body, "warned\n")
        assert.equal(seen[3]?.body, "true")
    })

    it("gathers a burst of lines into one request per stream", async () => {
        seen.length = 0
        const client = connect(RUN)
        for (let i = 0; i < 100; i++) client.stdout.write(`line ${i}\n`)
        await client.end()
        assert.deepEqual(seen.map(({path}) => path), ["/@tal/run/abc/begin", "/@tal/run/abc/stdout", "/@tal/run/abc/end"])
        assert.equal((seen[1]?.body ?? "").split("\n").length - 1, 100)
        assert.equal(seen[2]?.body, "true")
    })

    it("flushes on its own while the run goes on", async () => {
        seen.length = 0
        const client = connect(RUN)
        client.stdout.write("early\n")
        await sleep(200)
        assert.deepEqual(seen.map(({path, body}) => `${path} ${JSON.stringify(body)}`), ['/@tal/run/abc/begin ""', '/@tal/run/abc/stdout "early\\n"'])
        client.stdout.write("late\n")
        await client.end()
        assert.equal(seen.length, 4)
        assert.equal(seen[2]?.body, "late\n")
    })

    it("sends the run's verdict: false once a test failed", async () => {
        seen.length = 0
        const client = connect(RUN)
        client.it("fails", () => {
            throw new Error("no")
        })
        await client.end()
        assert.equal(seen.at(-1)?.body, "false")
    })

    it("sends text as given, and an Error as its text with a newline", async () => {
        seen.length = 0
        const client = connect(RUN)
        client.stderr.write("as ")
        client.stderr.write("given\n")
        client.stderr.write(new TypeError("typed"))
        await client.end()
        const lines = (seen[1]?.body ?? "").split("\n")
        assert.equal(lines[0], "as given")
        assert.match(lines[1] ?? "", /^TypeError: typed/)
        assert.equal(seen[1]?.body.endsWith("\n"), true)
    })

    it("text written before session() goes out once the session is open", async () => {
        seen.length = 0
        const local = createTAL()
        local.session.stdout.write("early\n")
        local.session.stderr.write("warned\n")
        local.session.session({base: RUN, output: () => undefined})
        await local.session.end()
        assert.deepEqual(seen.map(({path, body}) => `${path} ${JSON.stringify(body)}`), [
            '/@tal/run/abc/begin ""',
            '/@tal/run/abc/stdout "early\\n"',
            '/@tal/run/abc/stderr "warned\\n"',
            '/@tal/run/abc/end "true"',
        ])
    })

    it("text written after end() waits for the next session", async () => {
        seen.length = 0
        const local = createTAL()
        local.session.session({base: RUN, output: () => undefined})
        await local.session.end()
        local.session.stdout.write("later\n")
        assert.equal(seen.length, 2)
        local.session.session({base: RUN, output: () => undefined})
        await local.session.end()
        assert.deepEqual(seen.slice(2).map(({path, body}) => `${path} ${JSON.stringify(body)}`), [
            '/@tal/run/abc/begin ""',
            '/@tal/run/abc/stdout "later\\n"',
            '/@tal/run/abc/end "true"',
        ])
    })

    // A console of the test's own stands in for the page's.
    it("takes a console: log to stdout, error to stderr, a call a line, and gives it back at the end", async () => {
        seen.length = 0
        const fake = {
            log: (..._: unknown[]) => undefined,
            info: (..._: unknown[]) => undefined,
            debug: (..._: unknown[]) => undefined,
            warn: (..._: unknown[]) => undefined,
            error: (..._: unknown[]) => undefined,
        }
        const {log, warn} = fake
        const local = createTAL()
        local.session.session({base: RUN, output: () => undefined, console: fake})
        assert.notEqual(fake.log, log)
        fake.log("a", 1, "b")
        fake.info("info")
        fake.debug("debug")
        fake.warn("warned")
        fake.error(new TypeError("typed"))
        await local.session.end()
        assert.equal(fake.log, log)
        assert.equal(fake.warn, warn)
        assert.equal(seen[1]?.path, "/@tal/run/abc/stdout")
        assert.equal(seen[1]?.body, "a 1 b\ninfo\ndebug\n")
        assert.equal(seen[2]?.path, "/@tal/run/abc/stderr")
        const lines = (seen[2]?.body ?? "").split("\n")
        assert.equal(lines[0], "warned")
        assert.match(lines[1] ?? "", /^TypeError: typed/)
    })

    it("takes a URL for the base as well as a string", async () => {
        seen.length = 0
        const client = connect(new URL(RUN))
        await client.end()
        assert.deepEqual(seen.map(({path}) => path), ["/@tal/run/abc/begin", "/@tal/run/abc/end"])
    })

    it("does not reject when a request fails", async () => {
        const client = connect(GONE)
        client.stdout.write("lost\n")
        await client.end()
    })

    // A base outside a run's URL opens no channel: the session reports as
    // it would with none, and end() sends nothing.
    it("a base outside a run's URL sends nothing", async () => {
        seen.length = 0
        const client = connect("http://127.0.0.1:1/")
        client.stdout.write("")
        await client.end()
        assert.equal(seen.length, 0)
    })
})
