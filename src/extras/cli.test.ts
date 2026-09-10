import {strict as assert} from "node:assert"
import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {createServer} from "node:net"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import {CLI} from "./cli.ts"

// readOptions() throws before createApp() runs, so a bad argument cannot
// reach this any more; options.test.ts covers what it refuses and reads.
// What a running --serve leaves behind once serve() itself has failed is
// the one boundary that still needs a real port and a real watch.
const watching = async (): Promise<number> => {
    await new Promise(next => setTimeout(next, 50))
    return process.getActiveResourcesInfo().filter(name => name === "FSEventWrap").length
}

describe("extras/cli", () => {
    let dir: string
    let suite: string

    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tal-cli-"))
        suite = join(dir, "suite.mjs")
        await writeFile(suite, "export const suite = 1")
    })

    after(async () => {
        await rm(dir, {recursive: true, force: true})
    })

    it("leaves no watch behind when the port asked for is taken", async () => {
        const taken = createServer()
        await new Promise<void>(listening => taken.listen(0, "127.0.0.1", listening))
        const address = taken.address()
        const port = typeof address === "object" && address != null ? address.port : 0
        const before = await watching()
        try {
            await assert.rejects(CLI({args: ["--serve", "--port", String(port), suite]}), /EADDRINUSE/)
            assert.equal(await watching(), before)
        } finally {
            taken.close()
        }
    })
})
