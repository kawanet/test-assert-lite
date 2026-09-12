import {strict as assert} from "node:assert"
import type {Server} from "node:http"
import {createServer} from "node:http"
import {after, before, describe, it} from "node:test"
import {gzipSync} from "node:zlib"
import type {MiddlewareHandler} from "./middleware.ts"
import {compose, createContext} from "./middleware.ts"
import {proxy} from "./proxy.ts"

// The upstream: echoes what it got, or answers as its path says.
let upstream: Server
let base: string
const seen: {method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string}[] = []

const through = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const c = createContext(new Request(`http://127.0.0.1${path}`, init))
    await compose([proxy({path: "/app/", upstream: `${base}/site/`}), async c => c.body("not proxied", 200)])(c, async () => undefined)
    return c.res
}

describe("server/proxy", () => {
    before(async () => {
        upstream = createServer((req, res) => {
            let body = ""
            req.setEncoding("utf8")
            req.on("data", chunk => (body += chunk))
            req.on("end", () => {
                seen.push({method: req.method ?? "", url: req.url ?? "", headers: req.headers, body})
                if (req.url === "/site/gone") return res.writeHead(404, {"content-type": "text/plain"}).end("no such page")
                if (req.url === "/site/away") return res.writeHead(302, {location: "/site/"}).end()
                if (req.url === "/site/login") return res.writeHead(200, {"set-cookie": ["session=abc; Path=/", "csrf=xyz; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]}).end("in")
                if (req.url === "/site/zipped") return res.writeHead(200, {"content-type": "text/html", "content-encoding": "gzip"}).end(gzipSync("<head></head>unzipped"))
                res.writeHead(200, {"content-type": "text/html; charset=utf-8", "x-upstream": "yes", connection: "close"}).end(`<head></head>${body}`)
            })
        })
        await new Promise<void>(listening => upstream.listen(0, "127.0.0.1", listening))
        const address = upstream.address()
        base = `http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}`
    })

    after(() => {
        upstream.close()
        upstream.closeAllConnections()
    })

    it("fetches the path under the prefix from the upstream, query included, and hands the answer back", async () => {
        const res = await through("/app/page.html?x=1")
        assert.equal(res.status, 200)
        assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8")
        assert.equal(res.headers.get("x-upstream"), "yes")
        assert.equal(res.headers.get("connection"), null)
        assert.equal(await res.text(), "<head></head>")
        assert.equal(seen.at(-1)?.url, "/site/page.html?x=1")
    })

    it("forwards the method and the body, with the hop-by-hop headers and the host dropped", async () => {
        const res = await through("/app/post", {method: "POST", body: "hello", headers: {"content-type": "text/plain", connection: "keep-alive", "x-mine": "kept"}})
        assert.equal(res.status, 200)
        assert.equal(await res.text(), "<head></head>hello")
        const got = seen.at(-1)
        assert.equal(got?.method, "POST")
        assert.equal(got?.body, "hello")
        assert.equal(got?.headers["x-mine"], "kept")
        assert.equal(got?.headers["content-type"], "text/plain")
        assert.equal(got?.headers.host, new URL(base).host)
    })

    it("keeps every Set-Cookie the upstream sends", async () => {
        const res = await through("/app/login")
        assert.deepEqual(res.headers.getSetCookie(), ["session=abc; Path=/", "csrf=xyz; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT"])
    })

    it("asks the upstream for the path as it came, escapes and all", async () => {
        await through("/app/asset%23name.js?v=%3F")
        assert.equal(seen.at(-1)?.url, "/site/asset%23name.js?v=%3F")
    })

    it("passes a 404 and a redirect on as they are", async () => {
        const gone = await through("/app/gone")
        assert.equal(gone.status, 404)
        assert.equal(await gone.text(), "no such page")
        const away = await through("/app/away")
        assert.equal(away.status, 302)
        assert.equal(away.headers.get("location"), "/site/")
    })

    it("hands a compressed answer on decoded, its encoding and length dropped", async () => {
        const res = await through("/app/zipped")
        assert.equal(res.headers.get("content-encoding"), null)
        assert.equal(res.headers.get("content-length"), null)
        assert.equal(await res.text(), "<head></head>unzipped")
    })

    it("leaves a path outside the prefix to the next middleware", async () => {
        assert.equal(await (await through("/elsewhere")).text(), "not proxied")
    })

    it("answers 502 when the upstream cannot be reached", async () => {
        const c = createContext(new Request("http://127.0.0.1/app/x"))
        const dead: MiddlewareHandler = proxy({path: "/app/", upstream: "http://127.0.0.1:9/"})
        await compose([dead])(c, async () => undefined)
        assert.equal(c.res.status, 502)
    })
})
