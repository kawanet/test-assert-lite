import {strict as assert} from "node:assert"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {createServer} from "node:http"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import type {TAL} from "test-assert-lite"
import {createBufWriter} from "../../utils/buf-writer.ts"
import {createRunServices} from "../../utils/run-services.ts"
import {createApp} from "./app.ts"
import {serve} from "./serve.ts"

const TITLE = "extras/server/app.test.ts"

const get = async (url: string): Promise<{status: number, type: string, body: string}> => {
    const res = await fetch(url)
    return {status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text()}
}

const post = async (url: string, body: string): Promise<number> => (await fetch(url, {method: "POST", body})).status

const postIPC = async (url: string, message: TAL.SessionEvent): Promise<number> => post(url, JSON.stringify(message))

const nullWriter: TAL.Writer = {write: (() => undefined)}

describe(TITLE, () => {
    let dir: string
    const stdout = nullWriter
    const stderr = nullWriter

    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tal-app-"))
    })

    after(async () => {
        await rm(dir, {recursive: true, force: true})
    })

    it("escapes a < in the config, so a name cannot close the tag, and reads it back", async () => {
        const services = createRunServices({stdout, stderr})
        const odd = createApp({session: {files: [], reporter: "</script><b>"}, services})
        const server = await serve({handler: odd.handler, services})
        try {
            const head = (await get(server.origin + "/")).body.split("</head>")[0] as string
            const config = head.indexOf('<script type="application/vnd.test-session+json">')
            const json = head.slice(head.indexOf("{", config), head.indexOf("</script>", config))
            assert.equal(json.includes("</script>"), false)
            assert.deepEqual(JSON.parse(json), {session: {reporter: "</script><b>", files: []}})
        } finally {
            await services.cleanup()
        }
    })

    it("serves without the reload, and says so once, where it cannot watch", async () => {
        const bufStderr = createBufWriter()
        const files = [join(dir, "missing", "suite.mjs")]
        const services = createRunServices({stdout, stderr: bufStderr})
        const blind = createApp({session: {files}, watch: true, services})
        const running = await serve({handler: blind.handler, services})
        try {
            assert.match(bufStderr.read(), /^watch is off: ENOENT/)
            const index = await get(running.origin + "/")
            assert.equal(index.status, 200)
            assert.equal(index.body.includes("/@tal/watch"), false)
            assert.equal((await get(running.origin + "/@tal/watch?after=0")).status, 404)
        } finally {
            await services.cleanup()
        }
    })

    it("serves a mounted directory at the root in place of htdocs, its HTML with the head", async () => {
        await mkdir(join(dir, "site"))
        await writeFile(join(dir, "site", "index.html"), "<html><head></head><body>mine</body></html>")
        const services = createRunServices({stdout, stderr})
        const files = [join(dir, "tests", "my suite.mjs")]
        const mounted = createApp({session: {files}, mount: join(dir, "site"), services})
        const running = await serve({handler: mounted.handler, services})
        try {
            const index = await get(running.origin + "/")
            assert.equal(index.status, 200)
            assert.ok(index.body.includes("mine"))
            assert.ok(index.body.includes('<script type="importmap">'))
            assert.equal((await get(running.origin + "/styles/test-assert-lite.css")).status, 404)
            assert.equal((await get(running.origin + mounted.page)).status, 200)
        } finally {
            await services.cleanup()
        }
    })

    it("serves a mounted directory without a suite: the library in the head, no suite tag, no suite mount", async () => {
        await mkdir(join(dir, "plain"))
        await writeFile(join(dir, "plain", "index.html"), "<html><head></head><body>plain</body></html>")
        const services = createRunServices({stdout, stderr})
        const bare = createApp({session: {files: []}, mount: join(dir, "plain"), watch: true, services})
        const running = await serve({handler: bare.handler, services})
        try {
            const index = (await get(running.origin + "/")).body
            assert.ok(index.includes('<script type="importmap">'))
            assert.equal(index.includes('type="module" src="/@tal/files/'), false)
            assert.equal((await get(running.origin + "/@tal/files/000000000/anything.mjs")).status, 404)
        } finally {
            await services.cleanup()
        }
    })

    it("leaves a mounted page with an import map of its own as it is, and says so on stderr", async () => {
        await mkdir(join(dir, "mapped"))
        await writeFile(join(dir, "mapped", "index.html"), '<html><head><script type="importmap">{"imports":{"mine":"/mine.mjs"}}</script></head><body>mapped</body></html>')
        const bufStderr = createBufWriter()
        const services = createRunServices({stdout, stderr: bufStderr})
        const files = [join(dir, "tests", "my suite.mjs")]
        const mapped = createApp({session: {files}, mount: join(dir, "mapped"), services})
        const running = await serve({handler: mapped.handler, services, quiet: true})
        try {
            const index = (await get(running.origin + "/")).body
            assert.equal(index.split("importmap").length - 1, 1)
            assert.ok(index.includes('"mine":"/mine.mjs"'))
            assert.equal(index.includes("/@tal/"), false)
            assert.deepEqual(bufStderr.read(), "import map of its own, left as it is: /\n")
            const run = (await get(running.origin + mapped.page)).body
            assert.ok(run.includes('<script type="importmap">'))
        } finally {
            await services.cleanup()
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
        const services = createRunServices({stdout, stderr})
        services.onCleanup(() => upstream.close())
        const address = upstream.address()
        const port = typeof address === "object" && address != null ? address.port : 0
        const files = [join(dir, "tests", "my suite.mjs")]
        const mounted = createApp({session: {files}, mount: `http://127.0.0.1:${port}/app/`, services})
        const running = await serve({handler: mounted.handler, services})
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
            await services.cleanup()
        }
    })

    it("serves a script given as [eval].js under the run's path, and names it as the one file", async () => {
        const services = createRunServices({stdout, stderr})
        const inline = createApp({session: {files: []}, eval: "console.log('<hi>')\n", services})
        const server = await serve({handler: inline.handler, services})
        try {
            const path = inline.page.replace(/run\.html$/, "[eval].js")
            const res = await get(server.origin + path)
            assert.equal(res.status, 200)
            assert.equal(res.type, "text/javascript; charset=utf-8")
            assert.equal(res.body, "console.log('<hi>')\n")
            const head = (await get(server.origin + inline.page)).body.split("</head>")[0] as string
            const config = head.indexOf('<script type="application/vnd.test-session+json">')
            const json = head.slice(head.indexOf("{", config), head.indexOf("</script>", config))
            assert.deepEqual(JSON.parse(json), {session: {files: [path]}})
        } finally {
            await services.cleanup()
        }
    })

    it("fails the verdict on anything but true", async () => {
        const services = createRunServices({stdout, stderr})
        const files = [join(dir, "tests", "my suite.mjs")]
        const other = createApp({session: {files}, services})
        const running = await serve({handler: other.handler, services})
        const endpoint = running.origin + other.page.replace(/run\.html$/, "ipcout")
        try {
            assert.equal(await post(endpoint, "BROKEN"), 400)
            assert.equal(await post(endpoint, "null"), 400)
            assert.equal(await post(endpoint, "true"), 400)
            assert.equal(await post(endpoint, "{}"), 400)
        } finally {
            await services.cleanup()
        }
    })

    it("asks about changes from both pages, and only with watch on", async () => {
        const file = join(dir, "watching.mjs")
        await writeFile(file, "export const watching = 1")
        const files = [file]
        const services = createRunServices({stdout, stderr})
        const watching = createApp({session: {files}, watch: true, singleRun: false, services})
        const running = await serve({handler: watching.handler, services})
        try {
            const index = (await get(running.origin + "/")).body
            assert.ok(index.includes("/@tal/watch?after="))
            assert.ok(index.includes("})(0)\n</script>"))

            const page = (await get(running.origin + watching.page)).body
            assert.ok(page.includes("/@tal/watch?after="))
            assert.ok(page.includes("})(0)\n</script>"))

            const endpoint = running.origin + watching.page.replace(/run\.html$/, "ipcout")
            assert.equal(await postIPC(endpoint, {type: "session:begin"}), 204)
            assert.equal(await postIPC(endpoint, {type: "session:end", data: {success: true}}), 204)

            const pending = get(running.origin + "/@tal/watch?after=0")
            await writeFile(file, "export const watching = 2")

            assert.equal((await pending).status, 200)
            const after = (await get(running.origin + "/")).body
            assert.ok(after.includes("/@tal/watch?after="))
            assert.ok(after.includes("})(1)\n</script>"))
        } finally {
            await services.cleanup()
        }
    })

    it("names its own pages after the suites' package, or the suites, and never a mounted page", async () => {
        const plain = await mkdtemp(join(tmpdir(), "tal-nopkg-"))
        await writeFile(join(plain, "a.mjs"), "")
        await writeFile(join(plain, "b <c>.mjs"), "")
        await mkdir(join(plain, "site"))
        await writeFile(join(plain, "site", "index.html"), "<html><head><title>{{title}}</title></head><body>{{title}}</body></html>")
        const servicesN = createRunServices({stdout, stderr})
        const servicesM = createRunServices({stdout, stderr})
        const servicesB = createRunServices({stdout, stderr})
        const namedFiles = [join(plain, "a.mjs"), join(plain, "b <c>.mjs"), join(plain, "a.mjs")]
        const named = createApp({session: {files: namedFiles}, services: servicesN})
        const mountedFiles = [join(plain, "a.mjs")]
        const mounted = createApp({session: {files: mountedFiles}, mount: join(plain, "site"), services: servicesM})
        const bare = createApp({session: {files: []}, mount: join(plain, "site"), services: servicesB})
        const serverN = await serve({handler: named.handler, services: servicesN})
        const serverM = await serve({handler: mounted.handler, services: servicesM})
        const serverB = await serve({handler: bare.handler, services: servicesB})
        try {
            assert.ok((await get(serverN!.origin + named.page)).body.includes("<title>a.mjs b &#60;c&#62;.mjs</title>"))
            assert.ok((await get(serverM!.origin + "/")).body.includes("<title>{{title}}</title>"))
            assert.ok((await get(serverM!.origin + mounted.page)).body.includes("<title>a.mjs</title>"))
            assert.ok((await get(serverB!.origin + bare.page)).body.includes("<title>test-assert-lite</title>"))
        } finally {
            await servicesN.cleanup()
            await servicesM.cleanup()
            await servicesB.cleanup()
            await rm(plain, {recursive: true, force: true})
        }
    })
})
