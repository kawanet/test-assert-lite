import {strict as assert} from "node:assert"
import {after, before, describe, it} from "node:test"
import {reporter} from "../index.ts"

const TITLE = "reporter/client.test.ts"

// The CLI's side without a network: fetch() is all the client sends with,
// so a stand-in takes what goes to the run below and keeps each request's
// path and body in arrival order, and refuses what goes to the run that
// is gone. Anything else goes on to the real fetch(): in a browser, the
// page's own client reports this very run through the same function.
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

const connect = reporter.client

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
        await client.begin()
        client.stdout("one\n")
        client.stderr("warned\n")
        client.stdout("two\n")
        await client.end(true)
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
        for (let i = 0; i < 100; i++) client.stdout(`line ${i}\n`)
        await client.end(false)
        assert.deepEqual(seen.map(({path}) => path), ["/@tal/run/abc/stdout", "/@tal/run/abc/end"])
        assert.equal((seen[0]?.body ?? "").split("\n").length - 1, 100)
        assert.equal(seen[1]?.body, "false")
    })

    it("flushes on its own while the run goes on", async () => {
        seen.length = 0
        const client = connect(RUN)
        client.stdout("early\n")
        await sleep(200)
        assert.deepEqual(seen.map(({path, body}) => `${path} ${JSON.stringify(body)}`), ['/@tal/run/abc/stdout "early\\n"'])
        client.stdout("late\n")
        await client.end(true)
        assert.equal(seen.length, 3)
        assert.equal(seen[1]?.body, "late\n")
    })

    it("sends anything but true as a failure", async () => {
        seen.length = 0
        const client = connect(RUN)
        await client.end("yes" as unknown as boolean)
        assert.equal(seen[0]?.body, "false")
    })

    it("keeps stderr in lines: an Error by its text, a newline where one lacks", async () => {
        seen.length = 0
        const client = connect(RUN)
        client.stderr("bare")
        client.stderr("ended\n")
        client.stderr(new TypeError("typed"))
        await client.end(true)
        const lines = (seen[0]?.body ?? "").split("\n")
        assert.equal(lines[0], "bare")
        assert.equal(lines[1], "ended")
        assert.match(lines[2] ?? "", /^TypeError: typed/)
        assert.equal(seen[0]?.body.endsWith("\n"), true)
    })

    it("takes a URL for the base as well as a string", async () => {
        seen.length = 0
        const client = connect(new URL(RUN))
        await client.begin()
        await client.end(true)
        assert.deepEqual(seen.map(({path}) => path), ["/@tal/run/abc/begin", "/@tal/run/abc/end"])
    })

    it("does not reject when a request fails", async () => {
        const client = connect(GONE)
        await client.begin()
        client.stdout("lost\n")
        await client.end(true)
    })
})
