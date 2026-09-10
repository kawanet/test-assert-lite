import {strict as assert} from "node:assert"
import type {Server} from "node:http"
import {createServer} from "node:http"
import {after, before, it} from "node:test"
import {describeSlow} from "../test-utils/slow.ts"
import {client as connect} from "./client.ts"

// The ⏳ line client.ts posts every ten real seconds of silence, on its own
// timer rather than one this suite can inject: the one wait in the reporter
// that has no shorter path, so it alone runs only with TAL_SLOW_TESTS set.

const seen: {path: string, body: string}[] = []
let server: Server
let base: string

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describeSlow("reporter/heartbeat", () => {
    before(async () => {
        server = createServer((req, res) => {
            let body = ""
            req.setEncoding("utf8")
            req.on("data", chunk => (body += chunk))
            req.on("end", () => {
                seen.push({path: req.url ?? "", body})
                res.writeHead(204)
                res.end()
            })
        })
        await new Promise<void>(listening => server.listen(0, "127.0.0.1", listening))
        const address = server.address()
        const port = typeof address === "object" && address != null ? address.port : 0
        base = `http://127.0.0.1:${port}/@tal/run/abc/`
    })

    after(() => {
        server.close()
        server.closeAllConnections()
    })

    it("says how long it has been silent, every ten seconds, while begun and not yet ended", async () => {
        seen.length = 0
        const client = connect(base)
        await client.begin()
        // A one-second margin past the second tick: the interval fires
        // once a second, so it is what a slow tick could cost, not what a
        // slow assertion or a slow body would (slow() widens those).
        await sleep(21_500)
        await client.end(true)
        const stderr = seen.filter(({path}) => path.endsWith("/stderr")).map(({body}) => body).join("")
        assert.match(stderr, /⏳ 10s\n/)
        assert.match(stderr, /⏳ 20s\n/)
    })
})
