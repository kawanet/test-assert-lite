// fetch() will do here: every URL below is well-formed, and what the
// server has to refuse is the server's own tests' concern.

import {strict as assert} from "node:assert"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import {pathToFileURL} from "node:url"
import type {TAL} from "test-assert-lite"
import {createBufWriter} from "../../utils/buf-writer.ts"
import {createRunServices} from "../../utils/run-services.ts"
import {ImportAliasItem, ImportMapItem, Imports} from "../imports.ts"
import type {App} from "./app.ts"
import {createApp} from "./app.ts"
import {createFiles} from "./files.ts"
import type {Server} from "./serve.ts"
import {serve} from "./serve.ts"

const TITLE = "extras/server/app-complex.test.ts"

const BEGIN: TAL.SessionEvent = {type: "session:begin"}
const SUCCESS: TAL.SessionEvent = {type: "session:end", data: {success: true}}
// const FAILURE: TAL.SessionEvent = {type: "session:end", data: {success: false}}

const get = async (url: string): Promise<{status: number, type: string, body: string}> => {
    const res = await fetch(url)
    return {status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text()}
}

const post = async (url: string, body: string): Promise<number> => (await fetch(url, {method: "POST", body})).status

const send = async (url: string, message: TAL.SessionEvent): Promise<number> => post(url, JSON.stringify(message))

const nullWriter: TAL.Writer = {write: (() => undefined)}

describe(TITLE, () => {
    let dir: string
    // Where the suites and the scripts are served from, and the alias.
    let tests: string
    let lib: string
    let app: App
    let server: Server
    const stdout = createBufWriter()
    const stderr = nullWriter
    const sharedServices = createRunServices({stdout, stderr})
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
        await writeFile(join(dir, "tests", "typed.ts"), "export const typed: number = 1\n")
        await writeFile(join(dir, "lib", "mod.mjs"), "export const mod = 1")
        await writeFile(join(dir, "secret.json"), "{}")
        await writeFile(join(dir, "package.json"), '{"name": "fixture-pkg"}')
        const laid = createFiles([join(dir, "tests", "my suite.mjs"), join(dir, "lib", "mod.mjs")])
        tests = laid.dirOf(join(dir, "tests", "my suite.mjs")).path
        lib = laid.dirOf(join(dir, "lib", "mod.mjs")).path
        const files = [join(dir, "tests", "my suite.mjs"), join(dir, "tests", "second.mjs")]
        app = createApp({
            session: {files},
            scripts: [join(dir, "tests", "setup.js"), join(dir, "tests", "set+up#2.js")],
            imports: new Imports([
                new ImportAliasItem(`mod=${join(dir, "lib", "mod.mjs")}`, cwd),
                new ImportAliasItem(`dep=${join(dir, "tests", "nested", "dep.mjs")}`, cwd),
                new ImportAliasItem("cdn=https://cdn.example/lib.js", cwd),
                new ImportMapItem("mine", "/mine.js", pathToFileURL(join(dir, "map.json"))),
                new ImportAliasItem(`mod=${join(dir, "lib", "mod.mjs")}`, cwd),
            ]),
            services: sharedServices,
        })
        server = await serve({
            handler: app.handler,
            services: sharedServices,
        })
    })

    after(async () => {
        await sharedServices.cleanup()
        await rm(dir, {recursive: true, force: true})
    })

    it("serves the index page at the root, the map and the config ahead of its own script, the scripts at the end of its head", async () => {
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
        const config = at('<script type="application/vnd.test-session+json">')
        assert.match(tests, /^\/@tal\/files\/[0-9a-f]{9}\/$/)
        const script = at(`<script src="${tests}setup.js"></script>`)
        const second = at(`<script src="${tests}set%2Bup%232.js"></script>`)
        assert.ok(map < config && config < script && script < second)
        assert.equal(head.includes('<script type="module" src='), false)
        const {session} = JSON.parse(head.slice(head.indexOf("{", config), head.indexOf("</script>", config)))
        assert.deepEqual(session, {files: [`${tests}my%20suite.mjs`, `${tests}second.mjs`]})
        const {imports} = JSON.parse(head.slice(head.indexOf("{", map), head.indexOf("</script>", map)))
        assert.equal(imports["node:test"], "/@tal/exports/test.js")
        assert.equal(imports["test-assert-lite"], "/@tal/dist/test-assert-lite.min.js")
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
        assert.match(res.body, /\bsession\(\{/)
        assert.ok(res.body.indexOf('<script type="importmap">') < res.body.indexOf('<script type="module">'))
        assert.ok(res.body.includes("<title>fixture-pkg</title>"))
        assert.ok(res.body.includes(`"files": [\n            "${tests}my%20suite.mjs",\n            "${tests}second.mjs"\n        ]`))
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

    it("serves a .ts from a directory as JavaScript, the types stripped by this Node", async t => {
        if (!process.features.typescript) return t.skip()
        const res = await get(url(`${tests}typed.ts`))
        assert.equal(res.status, 200)
        assert.equal(res.type, "text/javascript; charset=utf-8")
        assert.match(res.body, /^export const typed\s*=\s*1\n$/)
        assert.ok(!res.body.includes(":"))
    })

    it("refuses a .ts with 422 where this Node strips no types", async t => {
        if (process.features.typescript) return t.skip()
        assert.equal((await get(url(`${tests}typed.ts`))).status, 422)
    })

    it("serves the package's minified build, the bridges and the document root", async () => {
        assert.match((await get(url("/@tal/dist/test-assert-lite.min.js"))).body, /export\{/)
        assert.equal((await get(url("/@tal/exports/test.js"))).status, 200)
        assert.equal((await get(url("/@tal/exports/assert/strict.js"))).status, 200)
        assert.equal((await get(url("/styles/test-assert-lite.css"))).type, "text/css; charset=utf-8")
        assert.equal((await get(url("/favicon.svg"))).status, 200)
        assert.equal((await get(url("/package.json"))).status, 404)
        assert.equal((await get(url("/@tal/"))).status, 404)
    })

    it("serves the default page without reload, named after the suite package", async () => {
        assert.equal((await get(url("/"))).body.includes("/@tal/watch?after="), false)
        assert.equal((await get(url("/@tal/watch?after=0"))).status, 404)
        assert.ok((await get(url("/"))).body.includes("<title>fixture-pkg</title>\n"))
        assert.ok((await get(url("/"))).body.includes("<h1>fixture-pkg</h1>"))
    })

    it("takes the run's reports by POST under its path, and the verdict from end", async () => {
        const run = app.page.slice(0, -"run.html".length)
        assert.equal(await send(url(`${run}send`), BEGIN), 204)
        assert.equal(await post(url(`${run}stdout`), "one\n"), 204)
        assert.equal(stdout.read(), "one\n")
        assert.equal((await get(url(`${run}stdout`))).status, 405)
        assert.equal(await post(url(`${run}nothing`), ""), 404)
        assert.equal(await post(url("/index.html"), ""), 405)
        assert.equal(await send(url(`${run}send`), SUCCESS), 204)
        assert.equal((await sharedServices.finished)?.success, true)
    })
})
