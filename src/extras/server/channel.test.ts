import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {createChannel} from "./channel.ts"
import type {Context} from "./middleware.ts"
import {createContext} from "./middleware.ts"

const TITLE = "extras/server/channel.test.ts"

// The page's side, without a network: a POST under the run's path.
const post = async (run: {path: string, handler: (c: Context, next: () => Promise<void>) => Promise<Response | void>}, endpoint: string, body: string, method = "POST"): Promise<number> => {
    const c = createContext(new Request(`http://127.0.0.1${run.path}${endpoint}`, {method, body: method === "POST" ? body : null}))
    const res = await run.handler(c, async () => undefined)
    return res?.status ?? 0
}

describe(TITLE, () => {
    it("has a path of its own, and takes each report by POST under it", async () => {
        const stdout: string[] = []
        const stderr: string[] = []
        const run = createChannel({stdout: text => stdout.push(text), stderr: text => stderr.push(text)})
        assert.match(run.path, /^\/@tal\/run\/[0-9a-z]{9}\/$/)
        assert.equal(await post(run, "begin", ""), 204)
        assert.equal(await post(run, "stdout", "one\n"), 204)
        assert.equal(await post(run, "stderr", "warned\n"), 204)
        assert.equal(await post(run, "end", "true"), 204)
        assert.deepEqual(stdout, ["one\n"])
        assert.deepEqual(stderr, ["warned\n"])
        assert.equal(await run.done, true)
        run.close()
    })

    it("leaves another path to the next middleware, and refuses another method", async () => {
        const run = createChannel({stdout: () => undefined, stderr: () => undefined})
        assert.equal(await post(run, "stdout", "", "GET"), 405)
        assert.equal(await post(run, "nothing", ""), 0)
        assert.equal(await post({...run, path: "/@tal/run/000000000/"}, "end", "true"), 0)
        run.close()
    })

    it("fails the verdict on anything but true, and takes nothing after the end", async () => {
        const stdout: string[] = []
        const run = createChannel({stdout: text => stdout.push(text), stderr: () => undefined})
        assert.equal(await post(run, "end", "yes"), 204)
        assert.equal(await run.done, false)
        assert.equal(await post(run, "stdout", "late\n"), 204)
        assert.deepEqual(stdout, [])
        run.close()
    })

    it("runs of its own do not share a path", () => {
        const a = createChannel()
        const b = createChannel()
        assert.notEqual(a.path, b.path)
        a.close()
        b.close()
    })
})
