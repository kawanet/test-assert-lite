import {strict as assert} from "node:assert"
import {writeFileSync} from "node:fs"
import {mkdtemp, rename, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import {createContext} from "./middleware.ts"
import type {Watcher} from "./watch.ts"
import {createWatcher} from "./watch.ts"

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The page's ask, without a network: GET /@tal/watch?after=<version>.
const ask = async (watcher: Watcher, after: number, method = "GET"): Promise<{status: number, body: string}> => {
    const c = createContext(new Request(`http://127.0.0.1/@tal/watch?after=${after}`, {method}))
    const res = await watcher.handler(c, async () => undefined)
    return {status: res?.status ?? 0, body: res == null ? "" : await res.text()}
}

describe("server/watch", () => {
    let dir: string
    let file: string
    let other: string
    let watcher: Watcher

    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tal-watch-"))
        file = join(dir, "bundled.mjs")
        other = join(dir, "other.mjs")
        await writeFile(file, "v0")
        await writeFile(other, "v0")
        watcher = createWatcher([file], 300)
    })

    after(async () => {
        watcher.close()
        await rm(dir, {recursive: true, force: true})
    })

    it("holds an ask until the wait runs out, then answers 204", async () => {
        const started = Date.now()
        assert.deepEqual(await ask(watcher, 0), {status: 204, body: ""})
        assert.ok(Date.now() - started >= 250)
    })

    it("answers 200 with the version once the file changes, a burst as one", async () => {
        const before = watcher.version
        const pending = ask(watcher, before)
        await sleep(50)
        // Written back to back, with no turn of the loop between, so the
        // events arrive together whatever the machine's pace.
        for (let i = 1; i <= 5; i++) writeFileSync(file, `v${i}`)
        assert.deepEqual(await pending, {status: 200, body: String(before + 1)})
        assert.equal(watcher.version, before + 1)
        assert.deepEqual(await ask(watcher, before), {status: 200, body: String(before + 1)})
        assert.equal((await ask(watcher, before + 1)).status, 204)
    })

    it("counts writes spaced apart as their own changes, not merged into one", async () => {
        // Past the 100 ms debounce between them, so each settles on its own;
        // still well short of a slow test, just past the boundary it tests.
        const before = watcher.version
        writeFileSync(file, "a")
        await sleep(150)
        assert.equal(watcher.version, before + 1)
        writeFileSync(file, "b")
        await sleep(150)
        assert.equal(watcher.version, before + 2)
    })

    it("sees a file saved by a rename over it, and again after that", async () => {
        const before = watcher.version
        await writeFile(join(dir, ".tmp"), "renamed")
        await rename(join(dir, ".tmp"), file)
        assert.equal((await ask(watcher, before)).status, 200)
        const renamed = watcher.version
        await writeFile(file, "after the rename")
        assert.deepEqual(await ask(watcher, renamed), {status: 200, body: String(renamed + 1)})
    })

    it("ignores another file in the directory", async () => {
        const before = watcher.version
        await writeFile(other, "v1")
        assert.equal((await ask(watcher, before)).status, 204)
    })

    it("leaves another path to the next middleware, and refuses another method", async () => {
        const c = createContext(new Request("http://127.0.0.1/@tal/watching"))
        assert.equal(await watcher.handler(c, async () => undefined), undefined)
        assert.equal((await ask(watcher, watcher.version, "POST")).status, 405)
    })

    it("leaves no watcher open when a later directory cannot be watched", async () => {
        // A closed watcher leaves the process's active resources a beat later.
        const open = async (): Promise<number> => {
            await sleep(50)
            return process.getActiveResourcesInfo().filter(name => name === "FSEventWrap").length
        }
        const before = await open()
        assert.throws(() => createWatcher([file, join(dir, "missing", "setup.js")]), /ENOENT/)
        assert.equal(await open(), before)
    })

    it("releases a pending ask with 204 when closed", async () => {
        const closing = createWatcher([file], 10_000)
        const pending = ask(closing, closing.version)
        await sleep(50)
        closing.close()
        assert.equal((await pending).status, 204)
    })
})
