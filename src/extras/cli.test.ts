import {strict as assert} from "node:assert"
import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {createServer} from "node:net"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, describe, it} from "node:test"
import {CLI} from "./cli.ts"

const TITLE = "extras/cli.test.ts"

// What the CLI itself does between reading the arguments and running
// them: options.test.ts covers the reading. A watch still open would keep
// the process up; a closed one leaves the count a beat later.
const watching = async (): Promise<number> => {
    await new Promise(next => setTimeout(next, 50))
    return process.getActiveResourcesInfo().filter(name => name === "FSEventWrap").length
}

describe(TITLE, () => {
    // A file of its own for --serve to watch, as index.js, whatever was built.
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

    // A suite that throws while loading is one failed test.
    it("files a suite that threw while loading as one failed test, and runs the rest", async () => {
        const broken = join(dir, "broken.mjs")
        const fine = join(dir, "fine.mjs")
        await writeFile(broken, `import {it} from "node:test"\nit("declared before the throw", () => undefined)\nthrow new Error("at the top level")\n`)
        await writeFile(fine, `import {it} from "node:test"\nit("in the other suite", () => undefined)\n`)
        const chunks: string[] = []
        const write = process.stdout.write
        process.stdout.write = ((text: string) => !!chunks.push(text)) as typeof write
        try {
            assert.equal(await CLI({args: ["--reporter", "tap", broken, fine]}), 1)
        } finally {
            process.stdout.write = write
        }
        const lines = chunks.join("").split("\n")
        const results = lines.filter(line => /^(not )?ok /.test(line))
        assert.deepEqual(results, ["ok 1 - declared before the throw", `not ok 2 - broken.mjs`, "ok 3 - in the other suite"])
        assert.ok(lines.includes("# Error: at the top level"), lines.join("\n"))
    })

    it("runs the script -e gives in place of the files, its tests through the same hook", async () => {
        const helper = join(dir, "helper.mjs")
        await writeFile(helper, `export const name = "inline"\n`)
        const chunks: string[] = []
        const write = process.stdout.write
        const cwd = process.cwd()
        process.stdout.write = ((text: string) => !!chunks.push(text)) as typeof write
        process.chdir(dir)
        try {
            const script = `import {it} from "node:test"\nimport {name} from "./helper.mjs"\nit(name, () => undefined)\n`
            assert.equal(await CLI({args: ["--reporter", "tap", "-e", script]}), 0)
        } finally {
            process.chdir(cwd)
            process.stdout.write = write
        }
        const lines = chunks.join("").split("\n")
        assert.deepEqual(lines.filter(line => /^(not )?ok /.test(line)), ["ok 1 - inline"])
    })

    it("leaves no watch behind when the port asked for is taken", async () => {
        const taken = createServer()
        await new Promise<void>(listening => taken.listen(0, "127.0.0.1", listening))
        const address = taken.address()
        const port = typeof address === "object" && address != null ? address.port : 0
        const before = await watching()
        try {
            await assert.rejects(CLI({args: ["--serve", "--port", String(port), "--alias", `index.js=${suite}`]}), /EADDRINUSE/)
            assert.equal(await watching(), before)
        } finally {
            taken.close()
        }
    })
})
