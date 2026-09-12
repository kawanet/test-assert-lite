import {strict as assert} from "node:assert"
import {mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises"
import {request} from "node:http"
import {connect, createServer as listen} from "node:net"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import {compose} from "./middleware.ts"
import type {Server} from "./serve.ts"
import {serve} from "./serve.ts"
import {serveStatic} from "./static.ts"

interface Reply {
    status: number
    type: string
    length: string
    allow: string
    body: string
}

// Raw request: fetch() and the URL parser fold ".." away before sending,
// so the traversal cases below need the path to go out verbatim.
const call = (origin: string, path: string, method = "GET", body?: string, encoding: BufferEncoding = "utf8"): Promise<Reply> => new Promise((resolve, reject) => {
    const {hostname, port} = hostOf(origin)
    request({hostname, port, path, method}, res => {
        let body = ""
        res.setEncoding(encoding)
        res.on("data", chunk => (body += chunk))
        res.on("end", () => resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            length: String(res.headers["content-length"] ?? ""),
            allow: String(res.headers["allow"] ?? ""),
            body,
        }))
    }).on("error", reject).end(body)
})

// An IPv6 literal comes out of a URL in brackets, which a socket does not take.
const hostOf = (origin: string): {hostname: string, port: number} => {
    const {hostname, port} = new URL(origin)
    return {hostname: hostname.replace(/^\[|\]$/g, ""), port: Number(port)}
}

const get = (origin: string, path: string): Promise<Reply> => call(origin, path)

// A request written by hand, for what node:http would not send: no Host
// header, a Host that is no host, a target that is not a path.
const raw = (origin: string, lines: string): Promise<{status: string, body: string}> => new Promise((resolve, reject) => {
    const {hostname, port} = hostOf(origin)
    let data = ""
    const socket = connect(port, hostname, () => socket.write(lines))
    socket.on("data", chunk => (data += chunk))
    socket.on("end", () => resolve({status: data.split(" ")[1] ?? "", body: data.slice(data.indexOf("\r\n\r\n") + 4)}))
    socket.on("error", reject)
})

// A port nobody listens on right now, for the tests that pick one.
const freePort = (): Promise<number> => new Promise(resolve => {
    const probe = listen().listen(0, "127.0.0.1", () => {
        const address = probe.address()
        const port = typeof address === "object" && address != null ? address.port : 0
        probe.close(() => resolve(port))
    })
})

describe("server/serve", () => {
    let dir: string
    let server: Server
    const lines: string[] = []
    const posted: string[] = []

    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tal-server-"))
        await mkdir(join(dir, "htdocs"))
        await mkdir(join(dir, "dist"))
        await mkdir(join(dir, "elsewhere"))
        await writeFile(join(dir, "htdocs", "page.html"), "<p>page</p>")
        await writeFile(join(dir, "htdocs", "index.html"), "<p>index</p>")
        await mkdir(join(dir, "htdocs", "sub"))
        await writeFile(join(dir, "htdocs", "sub", "index.html"), "<p>sub</p>")
        await writeFile(join(dir, "htdocs", "icon.svg"), "<svg/>")
        // Bytes no text encoding would keep, as a favicon or an image has them.
        await writeFile(join(dir, "htdocs", "favicon.ico"), Buffer.from([0, 0, 1, 0, 255, 254, 128, 10, 13]))
        await writeFile(join(dir, "htdocs", "pic.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        await writeFile(join(dir, "htdocs", "pic.jpg"), Buffer.from([255, 216, 255, 224]))
        await writeFile(join(dir, "dist", "lib.mjs"), "export const lib = 1")
        await writeFile(join(dir, "dist", "my lib.mjs"), "export const lib = 2")
        for (const name of ["a#b.mjs", "a+b.mjs", "a%b.mjs", "a%20b.mjs"]) await writeFile(join(dir, "dist", name), `export const name = ${JSON.stringify(name)}`)
        await mkdir(join(dir, "dist", "nested"))
        await writeFile(join(dir, "dist", "nested", "deep.mjs"), "export const deep = 1")
        await writeFile(join(dir, "dist", "legacy.cjs"), "module.exports = {}")
        await writeFile(join(dir, "dist", "source.ts"), "export const source: number = 1")
        await writeFile(join(dir, "dist", "data.json"), "{}")
        await symlink("..", join(dir, "dist", "up"))
        await symlink("lib.mjs", join(dir, "dist", "alias.mjs"))
        await writeFile(join(dir, "elsewhere", "suite.mjs"), "export const suite = 1")
        await writeFile(join(dir, "secret.json"), "{}")
        server = await serve({
            handler: compose([
                async (c, next) => {
                    if (c.req.method !== "POST" || c.req.path !== "/@tal/run/1/stdout") return next()
                    posted.push(await c.req.text())
                    return c.body(null, 204)
                },
                async (c, next) => (c.req.path === "/boom" ? Promise.reject(new Error("boom")) : next()),
                async (c, next) => (c.req.path === "/url" ? c.body(c.req.url) : next()),
                async (c, next) => (c.req.path === "/broken"
                    ? c.body(new ReadableStream({start: controller => controller.error(new Error("broken body"))}))
                    : next()),
                serveStatic({path: "/dist/", root: join(dir, "dist")}),
                serveStatic({path: "/@tal/tests/0/my suite.mjs", root: join(dir, "elsewhere", "suite.mjs")}),
                serveStatic({path: "/", root: join(dir, "htdocs")}),
            ]),
            log: line => lines.push(line),
        })
    })

    after(async () => {
        server.close()
        await rm(dir, {recursive: true, force: true})
    })

    it("listens on a loopback port", () => {
        assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    })

    it("serves the document root with a content type and length", async () => {
        const res = await get(server.origin, "/page.html")
        assert.equal(res.status, 200)
        assert.equal(res.type, "text/html; charset=utf-8")
        assert.equal(res.length, "11")
        assert.equal(res.body, "<p>page</p>")
        assert.equal((await get(server.origin, "/icon.svg")).type, "image/svg+xml")
        assert.equal((await get(server.origin, "/dist/data.json")).type, "application/json; charset=utf-8")
    })

    it("serves a binary file as it is, with its type alone and no charset", async () => {
        const ico = await call(server.origin, "/favicon.ico", "GET", undefined, "binary")
        assert.equal(ico.status, 200)
        assert.equal(ico.type, "image/x-icon")
        assert.equal(ico.length, "9")
        assert.deepEqual([...Buffer.from(ico.body, "binary")], [0, 0, 1, 0, 255, 254, 128, 10, 13])
        assert.equal((await get(server.origin, "/pic.png")).type, "image/png")
        assert.equal((await get(server.origin, "/pic.jpg")).type, "image/jpeg")
    })

    it("serves a directory mount before the root, nested paths and a percent-encoded name", async () => {
        const res = await get(server.origin, "/dist/lib.mjs")
        assert.equal(res.status, 200)
        assert.equal(res.type, "text/javascript; charset=utf-8")
        const cjs = await get(server.origin, "/dist/legacy.cjs")
        assert.equal(cjs.status, 200)
        assert.equal(cjs.type, "text/javascript; charset=utf-8")
        assert.equal((await get(server.origin, "/dist/nested/deep.mjs")).status, 200)
        assert.equal((await get(server.origin, "/dist/my%20lib.mjs")).body, "export const lib = 2")
    })

    it("finds a file whose name has a reserved character or a percent sign, by its encoded URL", async () => {
        for (const name of ["a#b.mjs", "a+b.mjs", "a%b.mjs", "a%20b.mjs"]) {
            const res = await get(server.origin, `/dist/${encodeURIComponent(name)}`)
            assert.equal(res.status, 200, name)
            assert.equal(res.body, `export const name = ${JSON.stringify(name)}`)
        }
        assert.equal((await get(server.origin, "/dist/a%20b.mjs")).status, 404)
    })

    it("listens on the loopback address for an empty host as for none", async () => {
        const other = await serve({handler: async c => c.body("x"), host: ""})
        try {
            assert.match(other.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
            assert.equal((await get(other.origin, "/")).body, "x")
        } finally {
            other.close()
        }
    })

    it("serves a mounted file by its decoded path, and nothing beside it", async () => {
        assert.equal((await get(server.origin, "/@tal/tests/0/my%20suite.mjs")).status, 200)
        assert.equal((await get(server.origin, "/@tal/tests/0/suite.mjs")).status, 404)
    })

    it("answers a directory, named with a slash, with its index.html", async () => {
        assert.equal((await get(server.origin, "/")).body, "<p>index</p>")
        assert.equal((await get(server.origin, "/sub/")).body, "<p>sub</p>")
        assert.equal((await get(server.origin, "/sub")).status, 404)
    })

    it("answers 404 for a missing file, a directory and a path without a kind", async () => {
        assert.equal((await get(server.origin, "/missing.html")).status, 404)
        assert.equal((await get(server.origin, "/dist/")).status, 404)
        assert.equal((await get(server.origin, "/dist/nested")).status, 404)
        assert.equal((await get(server.origin, "/dist/missing")).status, 404)
    })

    it("refuses a kind it does not serve with 403, when the file is there", async () => {
        assert.equal((await get(server.origin, "/dist/source.ts")).status, 403)
        assert.equal((await get(server.origin, "/dist/missing.ts")).status, 404)
    })

    it("refuses to leave the root or a mount", async () => {
        assert.equal((await get(server.origin, "/../secret.json")).status, 404)
        assert.equal((await get(server.origin, "/dist/../secret.json")).status, 404)
        assert.equal((await get(server.origin, "/dist/%2e%2e/secret.json")).status, 404)
        assert.equal((await get(server.origin, "/secret.json")).status, 404)
    })

    it("follows a symlink inside the directory but not one leading out", async () => {
        assert.equal((await get(server.origin, "/dist/alias.mjs")).status, 200)
        assert.equal((await get(server.origin, "/dist/up/secret.json")).status, 404)
    })

    it("refuses a malformed escape", async () => {
        assert.equal((await get(server.origin, "/dist/%zz.mjs")).status, 404)
    })

    it("writes every Set-Cookie a Response carries as a line of its own", async () => {
        const cookies = await serve({
            handler: async () => {
                const headers = new Headers({"content-type": "text/plain"})
                headers.append("set-cookie", "a=1; Path=/")
                headers.append("set-cookie", "b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT")
                return new Response("in", {headers})
            },
        })
        try {
            const res = await fetch(cookies.origin + "/")
            assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT"])
        } finally {
            cookies.close()
        }
    })

    it("answers a HEAD with the headers alone, and any other method with 405", async () => {
        const head = await call(server.origin, "/dist/lib.mjs", "HEAD")
        assert.equal(head.status, 200)
        assert.equal(head.length, "20")
        assert.equal(head.body, "")
        const put = await call(server.origin, "/dist/lib.mjs", "PUT", "x")
        assert.equal(put.status, 405)
        assert.equal(put.allow, "GET, HEAD")
        assert.equal((await call(server.origin, "/dist/legacy.cjs", "DELETE")).status, 405)
        assert.equal((await call(server.origin, "/dist/missing.mjs", "DELETE")).status, 404)
    })

    it("hands a POST's body to its middleware, and answers 404 elsewhere", async () => {
        assert.equal((await call(server.origin, "/@tal/run/1/stdout", "POST", "hello from the page\n")).status, 204)
        assert.deepEqual(posted, ["hello from the page\n"])
        assert.equal((await call(server.origin, "/@tal/run/1/nothing", "POST", "x")).status, 404)
        assert.equal((await get(server.origin, "/@tal/run/1/stdout")).status, 404)
    })

    it("answers 500 when the chain throws, and logs the error", async () => {
        const from = lines.length
        assert.equal((await get(server.origin, "/boom")).status, 500)
        assert.match(lines[from] ?? "", /^Error: boom\n/)
        assert.match(lines[from + 1] ?? "", /^GET \/boom 500 - - /)
    })

    it("answers 500 when the Response's body fails to be read, rather than hanging", async () => {
        const from = lines.length
        assert.equal((await get(server.origin, "/broken")).status, 500)
        assert.match(lines[from] ?? "", /^Error: broken body\n/)
        assert.match(lines[from + 1] ?? "", /^GET \/broken 500 - - /)
    })

    it("answers 400 to a target that is not a path, or a Host that is no host", async () => {
        assert.equal((await raw(server.origin, "GET * HTTP/1.0\r\nHost: x\r\n\r\n")).status, "400")
        assert.equal((await raw(server.origin, "GET /url HTTP/1.0\r\nHost: no host\r\n\r\n")).status, "400")
        // A Host with more than a host in it would make a URL, and another path.
        for (const host of ["example.test?x=", "example.test/foo", "u@example.test", "example.test#f", "[::1"]) {
            assert.equal((await raw(server.origin, `GET /url HTTP/1.0\r\nHost: ${host}\r\n\r\n`)).status, "400", host)
        }
        assert.equal((await raw(server.origin, "GET /url HTTP/1.0\r\nHost: [::1]:3000\r\n\r\n")).body, "http://[::1]:3000/url")
    })

    it("takes the request's URL from its Host header, and from the address listened on without one", async () => {
        assert.equal((await get(server.origin, "/url")).body, `${server.origin}/url`)
        assert.equal((await raw(server.origin, "GET /url HTTP/1.0\r\nHost: example.test:8080\r\n\r\n")).body, "http://example.test:8080/url")
        assert.equal((await raw(server.origin, "GET /url HTTP/1.0\r\n\r\n")).body, `${server.origin}/url`)
    })

    it("listens on the port asked for, and refuses one already taken", async () => {
        const port = await freePort()
        const fixed = await serve({handler: async c => c.body("fixed"), port})
        try {
            assert.equal(fixed.origin, `http://127.0.0.1:${port}`)
            assert.equal((await get(fixed.origin, "/")).body, "fixed")
            await assert.rejects(serve({handler: async c => c.body(""), port}), /EADDRINUSE/)
        } finally {
            fixed.close()
        }
    })

    it("names itself by the origin given, while the requests keep their own URL", async () => {
        const port = await freePort()
        const named = await serve({handler: async c => c.body(c.req.url), port, origin: "https://tal.example"})
        try {
            assert.equal(named.origin, "https://tal.example")
            assert.equal((await get(`http://127.0.0.1:${port}`, "/x")).body, `http://127.0.0.1:${port}/x`)
        } finally {
            named.close()
        }
    })

    it("names the loopback of the family for a wildcard address", async () => {
        const v4 = await serve({handler: async c => c.body("4"), host: "0.0.0.0"})
        const v6 = await serve({handler: async c => c.body("6"), host: "::"})
        try {
            assert.match(v4.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
            assert.match(v6.origin, /^http:\/\/\[::1\]:\d+$/)
            assert.equal((await get(v6.origin, "/")).body, "6")
        } finally {
            v4.close()
            v6.close()
        }
    })

    it("logs one line per response, in morgan's tiny format", async () => {
        const from = lines.length
        await get(server.origin, "/dist/lib.mjs")
        await get(server.origin, "/missing.html")
        await get(server.origin, "/dist/source.ts")
        assert.deepEqual(lines.slice(from).map(line => line.replace(/ \d+\.\d{3} ms$/, " N ms")), [
            "GET /dist/lib.mjs 200 20 - N ms",
            "GET /missing.html 404 - - N ms",
            "GET /dist/source.ts 403 - - N ms",
        ])
    })
})
