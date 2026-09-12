import {strict as assert} from "node:assert"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {createServer} from "node:http"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import {pathToFileURL} from "node:url"
import {ImportAliasItem, ImportMapItem, Imports} from "../imports.ts"
import type {App} from "./app.ts"
import {createApp} from "./app.ts"
import {createFiles} from "./files.ts"
import type {Server} from "./serve.ts"
import {serve} from "./serve.ts"

const TITLE = "extras/server/app.test.ts"

// fetch() will do here: every URL below is well-formed, and what the
// server has to refuse is the server's own tests' concern.
const get = async (url: string): Promise<{status: number, type: string, body: string}> => {
    const res = await fetch(url)
    return {status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text()}
}

const post = async (url: string, body: string): Promise<number> => (await fetch(url, {method: "POST", body})).status

describe(TITLE, () => {
    let dir: string
    // Where the suites and the scripts are served from, and the alias.
    let tests: string
    let lib: string
    let app: App
    let server: Server
    const stdout: string[] = []
    const url = (path: string): string => server.origin + path
    const cwd = pathToFileURL(`${process.cwd()}/`)

    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tal-app-"))
        await mkdir(join(dir, "tests", "nested"), {recursive: true})
        await mkdir(join(dir, "lib"))
        await writeFile(join(dir, "tests", "my suite.mjs"), "export const suite = 1")
        await writeFile(join(dir, "tests", "second.mjs"), "export const suite = 2")
        await writeFile(join(dir, "tests", "nested", "dep.mjs"), "export const dep = 1")
        await writeFile(join(dir, "tests", "setup.js"), "globalThis.setup = 1")
        await writeFile(join(dir, "tests", "set+up#2.js"), "globalThis.setup = 2")
        await writeFile(join(dir, "lib", "mod.mjs"), "export const mod = 1")
        await writeFile(join(dir, "secret.json"), "{}")
        await writeFile(join(dir, "package.json"), '{"name": "fixture-pkg"}')
        const laid = createFiles([join(dir, "tests", "my suite.mjs"), join(dir, "lib", "mod.mjs")])
        tests = laid.dirOf(join(dir, "tests", "my suite.mjs")).path
        lib = laid.dirOf(join(dir, "lib", "mod.mjs")).path
        app = createApp({
            suites: [join(dir, "tests", "my suite.mjs"), join(dir, "tests", "second.mjs")],
            scripts: [join(dir, "tests", "setup.js"), join(dir, "tests", "set+up#2.js")],
            imports: new Imports([
                new ImportAliasItem(`mod=${join(dir, "lib", "mod.mjs")}`, cwd),
                new ImportAliasItem(`dep=${join(dir, "tests", "nested", "dep.mjs")}`, cwd),
                new ImportAliasItem("cdn=https://cdn.example/lib.js", cwd),
                new ImportMapItem("mine", "/mine.js", pathToFileURL(join(dir, "map.json"))),
                new ImportAliasItem(`mod=${join(dir, "lib", "mod.mjs")}`, cwd),
            ]),
            stdout: text => stdout.push(text),
        })
        server = await serve({handler: app.handler})
    })

    after(async () => {
        app.close()
        server.close()
        await rm(dir, {recursive: true, force: true})
    })

    it("serves the index page at the root, the map and the tags at the end of its head", async () => {
        const res = await get(url("/"))
        assert.equal(res.status, 200)
        assert.equal(res.type, "text/html; charset=utf-8")
        const head = res.body.slice(0, res.body.indexOf("</head>"))
        const at = (text: string): number => {
            const i = head.indexOf(text)
            assert.notEqual(i, -1, text)
            return i
        }
        const map = at('<script type="importmap">')
        const iife = at('<script src="/@tal/dist/test-assert-lite.min.js"></script>')
        assert.match(tests, /^\/@tal\/files\/[0-9a-f]{9}\/$/)
        const script = at(`<script src="${tests}setup.js"></script>`)
        const second = at(`<script src="${tests}set%2Bup%232.js"></script>`)
        const suite = at(`<script type="module" src="${tests}my%20suite.mjs"></script>`)
        const other = at(`<script type="module" src="${tests}second.mjs"></script>`)
        assert.ok(map < iife && iife < script && script < second && second < suite && suite < other)
        const {imports} = JSON.parse(head.slice(head.indexOf("{", map), head.indexOf("</script>", map)))
        assert.equal(imports["node:test"], "/@tal/exports/test.mjs")
        assert.equal(imports["test-assert-lite"], "/@tal/exports/global.mjs")
        assert.equal(imports["mod"], `${lib}mod.mjs`)
        assert.equal(imports["dep"], `${tests}nested/dep.mjs`)
        assert.equal(imports["cdn"], "https://cdn.example/lib.js")
        assert.equal(imports["mine"], "/mine.js")
        assert.equal((await get(url("/index.html"))).body, res.body)
    })

    it("serves the run page under the run's path alone", async () => {
        assert.match(app.page, /^\/@tal\/run\/[0-9a-z]{9}\/run\.html$/)
        const res = await get(url(app.page))
        assert.equal(res.status, 200)
        assert.match(res.body, /reporter\.client/)
        assert.ok(res.body.includes("<title>fixture-pkg</title>"))
        assert.ok(res.body.includes(`<script type="module" src="${tests}my%20suite.mjs"></script>\n<script type="module" src="${tests}second.mjs"></script>\n</head>`))
        assert.equal((await get(url("/run.html"))).status, 404)
        assert.equal((await get(url("/@tal/run/000000000/run.html"))).status, 404)
    })

    it("serves the suites, the scripts and an alias from their directories, one under another through it", async () => {
        assert.equal((await get(url(`${tests}my%20suite.mjs`))).body, "export const suite = 1")
        assert.equal((await get(url(`${tests}second.mjs`))).body, "export const suite = 2")
        assert.equal((await get(url(`${tests}nested/dep.mjs`))).status, 200)
        assert.equal((await get(url(`${tests}setup.js`))).body, "globalThis.setup = 1")
        assert.equal((await get(url(`${tests}set%2Bup%232.js`))).body, "globalThis.setup = 2")
        assert.equal((await get(url(`${lib}mod.mjs`))).status, 200)
        assert.equal((await get(url(`${lib}my%20suite.mjs`))).status, 404)
        assert.equal((await get(url(`${lib}secret.json`))).status, 404)
        assert.equal((await get(url("/@tal/files/000000000/mod.mjs"))).status, 404)
    })

    it("serves the package's IIFE, its global face, the bridges and the document root, and not the ESM build", async () => {
        assert.equal((await get(url("/@tal/dist/test-assert-lite.min.js"))).status, 200)
        assert.match((await get(url("/@tal/exports/global.mjs"))).body, /globalThis\.TAL/)
        assert.equal((await get(url("/@tal/esm/test-assert-lite.mjs"))).status, 404)
        assert.equal((await get(url("/@tal/exports/test.mjs"))).status, 200)
        assert.equal((await get(url("/@tal/exports/assert/strict.mjs"))).status, 200)
        assert.equal((await get(url("/styles/test-assert-lite.css"))).type, "text/css; charset=utf-8")
        assert.equal((await get(url("/favicon.svg"))).status, 200)
        assert.equal((await get(url("/package.json"))).status, 404)
        assert.equal((await get(url("/@tal/"))).status, 404)
    })

    it("takes the run's reports by POST under its path, and the verdict from end", async () => {
        const run = app.page.slice(0, -"run.html".length)
        assert.equal(await post(url(`${run}begin`), ""), 204)
        assert.equal(await post(url(`${run}stdout`), "one\n"), 204)
        assert.deepEqual(stdout, ["one\n"])
        assert.equal((await get(url(`${run}stdout`))).status, 405)
        assert.equal(await post(url(`${run}nothing`), ""), 404)
        assert.equal(await post(url("/index.html"), ""), 405)
        assert.equal(await post(url(`${run}end`), "true"), 204)
        assert.equal(await app.done, true)
    })

    it("asks about changes from the page people open alone, and only with watch on", async () => {
        assert.equal((await get(url("/"))).body.includes("/@tal/watch?after="), false)
        assert.equal((await get(url("/@tal/watch?after=0"))).status, 404)
        const watching = createApp({suites: [join(dir, "tests", "my suite.mjs")], watch: true, stdout: () => undefined})
        const running = await serve({handler: watching.handler})
        try {
            const index = (await get(running.origin + "/")).body
            assert.ok(index.includes("/@tal/watch?after=${after}"))
            assert.ok(index.includes("})(0)\n</script>\n</head>"))
            assert.equal((await get(running.origin + watching.page)).body.includes("/@tal/watch"), false)
            const pending = get(running.origin + "/@tal/watch?after=0")
            await writeFile(join(dir, "tests", "my suite.mjs"), "export const suite = 2")
            assert.equal((await pending).status, 200)
            assert.ok((await get(running.origin + "/")).body.includes("})(1)\n</script>"))
        } finally {
            watching.close()
            running.close()
        }
    })

    it("serves without the reload, and says so once, where it cannot watch", async () => {
        const lines: string[] = []
        const blind = createApp({suites: [join(dir, "missing", "suite.mjs")], watch: true, stdout: () => undefined, stderr: text => lines.push(text)})
        const running = await serve({handler: blind.handler})
        try {
            assert.equal(lines.length, 1)
            assert.match(lines[0] ?? "", /^watch is off: ENOENT/)
            const index = await get(running.origin + "/")
            assert.equal(index.status, 200)
            assert.equal(index.body.includes("/@tal/watch"), false)
            assert.equal((await get(running.origin + "/@tal/watch?after=0")).status, 404)
        } finally {
            blind.close()
            running.close()
        }
    })

    it("names its own pages after the suites' package, or the suites, and never a mounted page", async () => {
        assert.ok((await get(url("/"))).body.includes("<title>fixture-pkg</title>\n"))
        assert.ok((await get(url("/"))).body.includes("<h1>fixture-pkg</h1>"))
        const plain = await mkdtemp(join(tmpdir(), "tal-nopkg-"))
        await writeFile(join(plain, "a.mjs"), "")
        await writeFile(join(plain, "b <c>.mjs"), "")
        await mkdir(join(plain, "site"))
        await writeFile(join(plain, "site", "index.html"), "<html><head><title>{{title}}</title></head><body>{{title}}</body></html>")
        const named = createApp({suites: [join(plain, "a.mjs"), join(plain, "b <c>.mjs"), join(plain, "a.mjs")], stdout: () => undefined})
        const mounted = createApp({suites: [join(plain, "a.mjs")], mount: join(plain, "site"), stdout: () => undefined})
        const bare = createApp({mount: join(plain, "site"), stdout: () => undefined})
        const servers = await Promise.all([named, mounted, bare].map(app => serve({handler: app.handler})))
        try {
            assert.ok((await get(servers[0]!.origin + named.page)).body.includes("<title>a.mjs b &#60;c&#62;.mjs</title>"))
            assert.ok((await get(servers[1]!.origin + "/")).body.includes("<title>{{title}}</title>"))
            assert.ok((await get(servers[1]!.origin + mounted.page)).body.includes("<title>a.mjs</title>"))
            assert.ok((await get(servers[2]!.origin + bare.page)).body.includes("<title>test-assert-lite</title>"))
        } finally {
            for (const app of [named, mounted, bare]) app.close()
            for (const server of servers) server.close()
            await rm(plain, {recursive: true, force: true})
        }
    })

    it("serves a mounted directory at the root in place of htdocs, its HTML with the head", async () => {
        await mkdir(join(dir, "site"))
        await writeFile(join(dir, "site", "index.html"), "<html><head></head><body>mine</body></html>")
        const mounted = createApp({suites: [join(dir, "tests", "my suite.mjs")], mount: join(dir, "site"), stdout: () => undefined})
        const running = await serve({handler: mounted.handler})
        try {
            const index = await get(running.origin + "/")
            assert.equal(index.status, 200)
            assert.ok(index.body.includes("mine"))
            assert.ok(index.body.includes('<script type="importmap">'))
            assert.equal((await get(running.origin + "/styles/test-assert-lite.css")).status, 404)
            assert.equal((await get(running.origin + mounted.page)).status, 200)
        } finally {
            mounted.close()
            running.close()
        }
    })

    it("serves a mounted directory without a suite: the library in the head, no suite tag, no suite mount", async () => {
        await mkdir(join(dir, "plain"))
        await writeFile(join(dir, "plain", "index.html"), "<html><head></head><body>plain</body></html>")
        const bare = createApp({mount: join(dir, "plain"), watch: true, stdout: () => undefined})
        const running = await serve({handler: bare.handler})
        try {
            const index = (await get(running.origin + "/")).body
            assert.ok(index.includes('<script type="importmap">'))
            assert.ok(index.includes('<script src="/@tal/dist/test-assert-lite.min.js"></script>'))
            assert.equal(index.includes('type="module" src="/@tal/files/'), false)
            assert.equal((await get(running.origin + "/@tal/files/000000000/anything.mjs")).status, 404)
        } finally {
            bare.close()
            running.close()
        }
    })

    it("leaves a mounted page with an import map of its own as it is, and says so on stderr", async () => {
        await mkdir(join(dir, "mapped"))
        await writeFile(join(dir, "mapped", "index.html"), '<html><head><script type="importmap">{"imports":{"mine":"/mine.mjs"}}</script></head><body>mapped</body></html>')
        const lines: string[] = []
        const mapped = createApp({suites: [join(dir, "tests", "my suite.mjs")], mount: join(dir, "mapped"), stdout: () => undefined, stderr: text => lines.push(text)})
        const running = await serve({handler: mapped.handler})
        try {
            const index = (await get(running.origin + "/")).body
            assert.equal(index.split("importmap").length - 1, 1)
            assert.ok(index.includes('"mine":"/mine.mjs"'))
            assert.equal(index.includes("/@tal/"), false)
            assert.deepEqual(lines, ["import map of its own, left as it is: /\n"])
            const run = (await get(running.origin + mapped.page)).body
            assert.ok(run.includes('<script type="importmap">'))
        } finally {
            mapped.close()
            running.close()
        }
    })

    it("proxies a mounted URL at the root, its HTML with the head", async () => {
        const asked: string[] = []
        const upstream = createServer((req, res) => {
            asked.push(req.url ?? "")
            if (req.url === "/app/") return res.writeHead(200, {"content-type": "text/html"}).end("<html><head></head><body>theirs</body></html>")
            res.writeHead(404).end()
        })
        await new Promise<void>(listening => upstream.listen(0, "127.0.0.1", listening))
        const address = upstream.address()
        const port = typeof address === "object" && address != null ? address.port : 0
        const mounted = createApp({suites: [join(dir, "tests", "my suite.mjs")], mount: `http://127.0.0.1:${port}/app/`, stdout: () => undefined})
        const running = await serve({handler: mounted.handler})
        try {
            const index = await get(running.origin + "/")
            assert.equal(index.status, 200)
            assert.ok(index.body.includes("theirs"))
            assert.ok(index.body.includes('<script type="importmap">'))
            assert.equal((await get(running.origin + "/elsewhere")).status, 404)
            assert.equal((await get(running.origin + "/@tal/dist/test-assert-lite.min.js")).status, 200)
            assert.equal((await get(running.origin + "/@tal/nothing")).status, 404)
            assert.equal(asked.includes("/@tal/nothing"), false)
        } finally {
            mounted.close()
            running.close()
            upstream.close()
        }
    })

    it("fails the verdict on anything but true", async () => {
        const other = createApp({suites: [join(dir, "tests", "my suite.mjs")], stdout: () => undefined})
        const running = await serve({handler: other.handler})
        try {
            assert.equal(await post(running.origin + other.page.replace(/run\.html$/, "end"), "yes"), 204)
            assert.equal(await other.done, false)
        } finally {
            other.close()
            running.close()
        }
    })
})
