import {strict as assert} from "node:assert"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"
import {after, before, describe, it} from "node:test"
import {pathToFileURL} from "node:url"
import type {ImportBase} from "./imports.ts"
import {ImportAliasItem, ImportMapItem, Imports, importMapItems, readImportMap} from "./imports.ts"
import {createFiles} from "./server/files.ts"
import {UsageError} from "./usage-error.ts"

const cwd = pathToFileURL(`${process.cwd()}/`)
const mapFile = pathToFileURL(resolve("maps", "x.json"))
const alias = (entry: string): ImportAliasItem => new ImportAliasItem(entry, cwd)
const mapped = (specifier: string, address: unknown): ImportMapItem => new ImportMapItem(specifier, address, mapFile)
// The addresses are Files' to give, from the items' own files: this package's
// at fixed paths, the rest under a directory digest, blanked out to compare.
const serveFor = (...items: ImportBase[]): ((file: string) => string) => createFiles(new Imports(items).paths()).urlOf
const unhash = (address: string | undefined): string => address?.replace(/\/[0-9a-f]{9}\//, "/xxxxxxxxx/") || ""

const refused = (fn: () => unknown, reason: RegExp): void => {
    assert.throws(fn, (error: unknown) => {
        assert.ok(error instanceof UsageError)
        assert.match(error.message, reason)
        return true
    })
}

describe("extras/imports", () => {
    describe("an --alias item", () => {
        it("takes a relative, bare or absolute path against the working directory, in both modes", () => {
            for (const [entry, file, name] of [["a=./lib/x.mjs", resolve("lib", "x.mjs"), "x.mjs"], ["b=../y.mjs", resolve("..", "y.mjs"), "y.mjs"], ["c=vendor/z.mjs", resolve("vendor", "z.mjs"), "z.mjs"], ["d=/opt/w.mjs", "/opt/w.mjs", "w.mjs"]] as [string, string, string][]) {
                const item = alias(entry)
                assert.ok(item.isPath(), entry)
                assert.equal(item.getPath(), file)
                assert.equal(unhash(item.getAddress(serveFor(item))), `/@tal/files/xxxxxxxxx/${name}`)
                assert.equal(item.refusal("node"), undefined)
                assert.equal(item.refusal("browser"), undefined)
            }
            // A path into this package's own dist/ is served where the package serves it, not under a digest.
            const own = alias("e=dist/test-assert-lite.min.js")
            assert.equal(own.getAddress(serveFor(own)), "/@tal/dist/test-assert-lite.min.js")
        })

        it("takes a URL for a page, and refuses it under Node", () => {
            for (const entry of ["cdn=https://cdn.example/x.js", "inline=data:text/javascript,export default 1"]) {
                const item = alias(entry)
                assert.ok(item.isURL())
                assert.equal(item.getPath(), undefined)
                assert.equal(item.getAddress(serveFor(item)), entry.slice(entry.indexOf("=") + 1))
                assert.match(item.refusal("node") ?? "", /^--alias: a URL applies to --playwright, --webdriver and --serve only: "/)
                assert.equal(item.refusal("browser"), undefined)
            }
        })

        it("takes this package's own names as bundled, resolved from this package", () => {
            const item = alias("node:test=test-assert-lite/test")
            assert.ok(item.isBundled())
            assert.equal(item.isPath(), false)
            assert.match(item.getPath()!, /exports.test\.mjs$/)
            assert.equal(item.getAddress(serveFor(item)), "/@tal/exports/test.mjs")
            assert.match(alias("x=test-assert-lite").getPath()!, /esm.test-assert-lite\.mjs$/)
            assert.equal(alias("x=test-assert-lite").getAddress(serveFor()), "/@tal/exports/global.mjs")
            assert.equal(item.refusal("node"), undefined)
            assert.equal(item.refusal("browser"), undefined)
        })

        it("refuses a key a page would resolve against its base, in the browser modes only", () => {
            for (const entry of ["./a=x.mjs", "/a=x.mjs", "a/=lib/"]) {
                assert.match(alias(entry).refusal("browser") ?? "", /^--alias: no prefix entry or relative key: "/)
                assert.equal(alias(entry).refusal("node"), undefined)
            }
        })

        it("refuses an entry without a specifier or a target", () => {
            for (const entry of ["mod", "=x.mjs", "mod="]) refused(() => alias(entry), /^--alias takes <specifier>=<target>: /)
        })
    })

    describe("an import map item", () => {
        it("takes a relative address against the map file, in both modes", () => {
            const item = mapped("lib", "./lib/x.js")
            assert.ok(item.isPath())
            assert.equal(item.getPath(), resolve("maps", "lib", "x.js"))
            assert.equal(mapped("up", "../y.js").getPath(), resolve("y.js"))
            assert.equal(unhash(item.getAddress(serveFor(item))), "/@tal/files/xxxxxxxxx/x.js")
            assert.equal(item.refusal("node"), undefined)
            assert.equal(item.refusal("browser"), undefined)
        })

        it("passes / and a URL to the page as written, and refuses them under Node", () => {
            for (const [specifier, address] of [["root", "/vendor/z.js"], ["cdn", "https://cdn.example/w.js"]] as [string, string][]) {
                const item = mapped(specifier, address)
                assert.equal(item.isPath(), false)
                assert.equal(item.getPath(), undefined)
                assert.equal(item.getAddress(serveFor(item)), address)
                assert.match(item.refusal("node") ?? "", /^--import-map: an address starting with \/ or a scheme applies to --playwright, --webdriver and --serve only: "/)
                assert.equal(item.refusal("browser"), undefined)
            }
        })

        it("takes a URL as a key, and refuses a bare address, a prefix entry and a relative key", () => {
            assert.equal(mapped("https://cdn.example/lib.js", "./local.mjs").getPath(), resolve("maps", "local.mjs"))
            refused(() => mapped("a", "lodash"), /^--import-map: an address starts with \.\/, \.\.\/, \/ or a scheme: "a"$/)
            refused(() => mapped("a", "test-assert-lite/test"), /an address starts with/)
            refused(() => mapped("a", 1), /^--import-map: not a string: "a"$/)
            refused(() => mapped("a/", "./a/"), /^--import-map: no prefix entry or relative key: "a\/"$/)
            refused(() => mapped("./a", "./a.js"), /no prefix entry or relative key: "\.\/a"$/)
        })

        it("is read from the map's imports alone, in order", () => {
            assert.deepEqual(importMapItems({imports: {a: "./a.js", b: "/b.js"}}, mapFile).map(item => [item.specifier, item.target]), [["a", "./a.js"], ["b", "/b.js"]])
            assert.deepEqual(importMapItems({}, mapFile), [])
            refused(() => importMapItems([], mapFile), /^--import-map: not an object$/)
            refused(() => importMapItems({imports: {}, scopes: {}}, mapFile), /^--import-map: only "imports" is supported: "scopes"$/)
            refused(() => importMapItems({imports: []}, mapFile), /^--import-map: not an object: "imports"$/)
        })
    })

    describe("a map file", () => {
        let dir: string

        before(async () => {
            dir = await mkdtemp(join(tmpdir(), "tal-imports-"))
            await mkdir(join(dir, "maps"))
            await writeFile(join(dir, "maps", "a.json"), '{"imports": {"lib": "./lib/x.js"}}')
            await writeFile(join(dir, "maps", "bad.json"), '{"imports": {"a": "./a.js",}}')
        })

        after(async () => {
            await rm(dir, {recursive: true, force: true})
        })

        it("resolves a relative address against the file it was read from", () => {
            assert.equal(readImportMap(join(dir, "maps", "a.json"))[0]?.getPath(), join(dir, "maps", "lib", "x.js"))
        })

        it("refuses what it cannot read or parse, naming the option", () => {
            refused(() => readImportMap(join(dir, "maps", "none.json")), /^--import-map: ENOENT/)
            refused(() => readImportMap(join(dir, "maps", "bad.json")), /^--import-map: /)
        })
    })

    describe("the list", () => {
        it("starts with this package's defaults, which a later item takes over", () => {
            const list = new Imports([alias("node:test=./my-test.mjs")])
            assert.deepEqual([...list.entries().keys()], ["test-assert-lite", "test-assert-lite/test", "test-assert-lite/assert", "test-assert-lite/assert/strict", "node:test", "node:assert", "node:assert/strict"])
            assert.equal(list.entries().get("node:test")?.target, "./my-test.mjs")
            assert.equal(new Imports([]).entries().get("node:test")?.getAddress(serveFor()), "/@tal/exports/test.mjs")
        })

        it("names every path item's file once, losers included, and resolves each specifier to its last item", () => {
            const list = new Imports([alias("a=./one.mjs"), mapped("a", "./two.js"), alias("b=./one.mjs"), alias("c=https://cdn.example/c.js")])
            assert.deepEqual(list.paths(), [resolve("one.mjs"), resolve("maps", "two.js")])
            assert.equal(list.entries().get("a")?.target, "./two.js")
            assert.equal(list.entries().size, 7 + 3)
        })

        it("gives a page this package's names and each specifier's address", () => {
            const items = [alias("a=./one.mjs"), mapped("r", "/r.js")]
            const addresses = new Imports(items).addresses(serveFor(...items))
            assert.equal(addresses["test-assert-lite"], "/@tal/exports/global.mjs")
            assert.equal(addresses["node:assert"], "/@tal/exports/assert.mjs")
            assert.equal(unhash(addresses["a"]), "/@tal/files/xxxxxxxxx/one.mjs")
            assert.equal(addresses["r"], "/r.js")
        })

        it("refuses for a mode what the resolving item cannot be there, not what a later item took over", () => {
            assert.deepEqual(new Imports([mapped("r", "/r.js"), alias("u=https://x/y.js")]).refusals("browser"), [])
            assert.equal(new Imports([mapped("r", "/r.js"), alias("u=https://x/y.js")]).refusals("node").length, 2)
            assert.deepEqual(new Imports([mapped("r", "/r.js"), alias("r=./local.mjs")]).refusals("node"), [])
        })
    })
})
