// The channel on its own, without a network: each report of the page as
// a POST under the run's path.

import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {TAL} from "test-assert-lite"
import {createBufWriter} from "../../utils/buf-writer.ts"
import {createRunServices} from "../../utils/run-services.ts"
import {createChannel, type Channel} from "./channel.ts"
import {createContext} from "./middleware.ts"

const TITLE = "extras/server/channel.test.ts"

const nullWriter: TAL.Writer = {write: (() => undefined)}

const prefix = "/@tal/run/000000000/"
const otherPrefix = "/@tal/run/000000001/"

const BEGIN: TAL.SessionEvent = {type: "session:begin"}
const SUCCESS: TAL.SessionEvent = {type: "session:end", data: {success: true}}
// const FAILURE: TAL.SessionEvent = {type: "session:end", data: {success: false}}
const INVALID = {type: "INVALID"} as unknown as TAL.SessionEvent

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const post = async (channel: Channel, endpoint: string, body: string, method = "POST", path: string = prefix): Promise<number | "next" | undefined> => {
    const url = `http://127.0.0.1${path}${endpoint}`
    const c = createContext(new Request(url, {method, body: method === "POST" ? body : null}))
    let next: "next" | undefined = undefined
    const res = await channel.handler(c, async () => void (next = "next"))
    if (next) return next
    return res?.status
}

const send = async (channel: Channel, endpoint: "send", message: TAL.SessionEvent, method?: string, path?: string) => post(channel, endpoint, JSON.stringify(message), method, path)

describe(TITLE, {timeout: 1000}, () => {
    it("takes each report by POST under the given prefix", async () => {
        const stdout = createBufWriter()
        const stderr = createBufWriter()
        const services = createRunServices({stdout, stderr})
        const run = createChannel({prefix, services})
        assert.equal(await send(run, "send", BEGIN), 204)
        assert.equal(await post(run, "stdout", "one\n"), 204)
        assert.equal(await post(run, "stderr", "warned\n"), 204)
        assert.equal(await send(run, "send", SUCCESS), 204)
        assert.equal(stdout.read(), "one\n")
        assert.equal(stderr.read(), "warned\n")
        assert.equal((await services.finished)?.success, true)
        await services.cleanup()
    })

    it("leaves another path to the next middleware, and refuses another method", async () => {
        const services = createRunServices({stdout: nullWriter, stderr: nullWriter})
        const run = createChannel({prefix, services})
        assert.equal(await post(run, "stdout", "", "GET"), 405)
        assert.equal(await post(run, "nothing", ""), "next")
        assert.equal(await send(run, "send", SUCCESS, "POST", otherPrefix), "next")
        await services.cleanup()
    })

    it("fails with an invalid verdict", async () => {
        const stdout = createBufWriter()
        const stderr = createBufWriter()
        const services = createRunServices({stdout, stderr})
        const run = createChannel({prefix, services})
        assert.equal(await send(run, "send", INVALID), 400)
        await services.cleanup()
    })

    // The bound is short here; its messages tell before and after begin apart.
    it("fails the run when the page never begins within the silence given", async () => {
        const services = createRunServices({stdout: nullWriter, stderr: nullWriter})
        createChannel({prefix, services, timeout: 50})
        await assert.rejects(services.finished, /never reported in/)
        await services.cleanup()
    })

    it("fails the run when a page that has begun falls silent", async () => {
        const services = createRunServices({stdout: nullWriter, stderr: nullWriter})
        const run = createChannel({prefix, services, timeout: 50})
        assert.equal(await send(run, "send", BEGIN), 204)
        await assert.rejects(services.finished, /No word from the page/)
        await services.cleanup()
    })

    it("keeps the bound after a report it refused", async () => {
        const services = createRunServices({stdout: nullWriter, stderr: nullWriter})
        const run = createChannel({prefix, services, timeout: 50})
        assert.equal(await send(run, "send", BEGIN), 204)
        assert.equal(await send(run, "send", INVALID), 400)
        await assert.rejects(services.finished, /No word from the page/)
        await services.cleanup()
    })

    it("waits without a bound when multiple runs are allowed", async () => {
        const services = createRunServices({stdout: nullWriter, stderr: nullWriter})
        createChannel({prefix, services, singleRun: false})
        const outcome = await Promise.race([
            services.finished.then(() => "settled", () => "settled"),
            sleep(100).then(() => "pending"),
        ])
        assert.equal(outcome, "pending")
        await services.cleanup()
    })

    it("takes the streams after the end", async () => {
        const stdout = createBufWriter()
        const stderr = createBufWriter()
        const services = createRunServices({stdout, stderr})
        const run = createChannel({prefix, services})
        assert.equal(await send(run, "send", SUCCESS), 204)
        assert.equal((await services.finished)?.success, true)
        assert.equal(await post(run, "stdout", "after end 1\n"), 204)
        assert.equal(await post(run, "stderr", "after end 2\n"), 204)
        assert.equal(stdout.read(), "after end 1\n")
        assert.equal(stderr.read(), "after end 2\n")
        await services.cleanup()
    })
})
