import {strict as assert} from "node:assert"
import {resolve} from "node:path"
import {describe, it} from "node:test"
import {browserOf, mountOf, originOf, portOf, readOptions} from "./options.ts"

const TITLE = "extras/options.test.ts"

describe(TITLE, () => {
    describe("portOf", () => {
        it("takes a whole number a socket can have", () => {
            assert.equal(portOf("0"), 0)
            assert.equal(portOf("3000"), 3000)
            assert.equal(portOf("65535"), 65535)
        })

        it("refuses what is no port, with the value in the reason", () => {
            for (const value of ["65536", "-1", "3000.5", "port", "0x50", "1e3", "", " 3000 "]) {
                assert.throws(() => portOf(value), /--port takes a number from 0 to 65535: /)
            }
        })
    })

    describe("originOf", () => {
        it("takes scheme, host and port, as a URL reads them back", () => {
            assert.equal(originOf("http://tal.example:3000"), "http://tal.example:3000")
            assert.equal(originOf("https://tal.example:443/"), "https://tal.example")
            assert.equal(originOf("HTTP://Tal.Example/"), "http://tal.example")
            assert.equal(originOf("http://[::1]:3000/"), "http://[::1]:3000")
        })

        it("refuses another scheme, a path, a query, a fragment or credentials", () => {
            for (const value of ["tal.example", "tal.example:3000", "ftp://tal.example", "http://", "http://tal.example/base", "http://tal.example/?x", "http://tal.example/#f", "http://u:p@tal.example/"]) {
                assert.throws(() => originOf(value), /--origin takes http\(s\):\/\/host\[:port\]: /)
            }
        })
    })

    describe("browserOf", () => {
        it("takes one of Playwright's three, and nothing else", () => {
            assert.equal(browserOf("chromium"), "chromium")
            assert.equal(browserOf("firefox"), "firefox")
            assert.equal(browserOf("webkit"), "webkit")
            assert.throws(() => browserOf("electron"), /--playwright takes chromium, firefox or webkit: electron$/)
        })
    })

    describe("mountOf", () => {
        it("resolves a directory, and takes an http(s) URL as given up to its path, ending in a slash", () => {
            assert.equal(mountOf("site"), resolve("site"))
            assert.equal(mountOf("http://127.0.0.1:5173"), "http://127.0.0.1:5173/")
            assert.equal(mountOf("HTTPS://Example.com/app"), "https://example.com/app/")
            assert.equal(mountOf("http://x/app/"), "http://x/app/")
        })

        it("refuses a URL with a query, a fragment or credentials", () => {
            for (const value of ["http://x/?q=1", "http://x/#top", "http://u:p@x/", "http://"]) {
                assert.throws(() => mountOf(value), /--mount takes a directory or http\(s\):\/\/host\[:port\]\[\/path\]: /)
            }
        })
    })

    describe("readOptions", () => {
        it("reads --help ahead of anything else, and -h as --help", () => {
            assert.deepEqual(readOptions(["--help"]), {mode: "help"})
            assert.deepEqual(readOptions(["-h"]), {mode: "help"})
            assert.deepEqual(readOptions(["--help", "--serve", "--webdriver"]), {mode: "help"})
        })

        it("reads --version and -v, after --help", () => {
            assert.deepEqual(readOptions(["--version"]), {mode: "version"})
            assert.deepEqual(readOptions(["-v", "--serve", "suite.mjs"]), {mode: "version"})
            assert.deepEqual(readOptions(["-v", "-h"]), {mode: "help"})
        })

        it("reads Node mode as the default, the files resolved in order", () => {
            const options = readOptions(["a.test.ts", "b.test.ts"])
            assert.equal(options.mode, "node")
            if (options.mode !== "node") return
            assert.deepEqual(options.suites, [resolve("a.test.ts"), resolve("b.test.ts")])
            assert.deepEqual(options.imports.paths(), [])
        })

        it("refuses Node mode without a file, and a CommonJS suite in every mode", () => {
            assert.throws(() => readOptions([]))
            assert.throws(() => readOptions(["a.test.ts", "b.cjs", "c.cts"]), /CommonJS suites are not supported: b\.cjs, c\.cts$/)
            assert.throws(() => readOptions(["--serve", "b.cjs"]), /CommonJS suites are not supported: b\.cjs$/)
            assert.throws(() => readOptions(["--playwright", "chromium", "c.cts"]), /CommonJS suites are not supported: c\.cts$/)
        })

        it("refuses TypeScript in the browser modes, for a suite and for a --script, and takes it in Node mode", () => {
            assert.throws(() => readOptions(["--serve", "a.test.ts"]), /a browser runs no TypeScript: a\.test\.ts$/)
            assert.throws(() => readOptions(["--webdriver", "a.mts"]), /a browser runs no TypeScript: a\.mts$/)
            assert.throws(() => readOptions(["--serve", "--script", "setup.ts", "--script", "setup.cjs", "suite.mjs"]), /a browser runs no TypeScript: setup\.ts$/)
            assert.equal(readOptions(["--serve", "--script", "setup.cjs", "suite.mjs"]).mode, "serve")
            assert.equal(readOptions(["a.test.ts", "b.mts"]).mode, "node")
        })

        it("reads --serve: the suite resolved, nothing else set", () => {
            const options = readOptions(["--serve", "suite.mjs"])
            assert.ok(options.mode === "serve" && options.imports.paths().length === 0)
            assert.deepEqual({...options, imports: null}, {
                mode: "serve",
                suites: [resolve("suite.mjs")],
                scripts: [],
                imports: null,
                mount: undefined,
                host: undefined,
                port: undefined,
                origin: undefined,
            })
        })

        it("reads --host as given, --port and --origin checked and normalized", () => {
            const options = readOptions(["--serve", "--host", "0.0.0.0", "--port", "3000", "--origin", "https://tal.example:443/", "suite.mjs"])
            assert.equal(options.mode, "serve")
            if (options.mode !== "serve") return
            assert.equal(options.host, "0.0.0.0")
            assert.equal(options.port, 3000)
            assert.equal(options.origin, "https://tal.example")
            assert.throws(() => readOptions(["--serve", "--port", "port", "suite.mjs"]), /--port takes/)
            assert.throws(() => readOptions(["--serve", "--origin", "tal.example", "suite.mjs"]), /--origin takes/)
        })

        it("reads --script and --alias, each resolved, in order", () => {
            const options = readOptions(["--serve", "--script", "a.js", "--alias", "mod=m.mjs", "--script", "b.js", "suite.mjs"])
            assert.equal(options.mode, "serve")
            if (options.mode !== "serve") return
            assert.deepEqual(options.scripts, [resolve("a.js"), resolve("b.js")])
            assert.deepEqual(options.imports.paths(), [resolve("m.mjs")])
            assert.equal(options.imports.entries().get("mod")?.getPath(), resolve("m.mjs"))
            assert.throws(() => readOptions(["--serve", "--alias", "mod", "suite.mjs"]), /--alias takes/)
        })

        it("reads --alias in Node mode too", () => {
            const options = readOptions(["--alias", "node:crypto=sha256.mjs", "a.test.ts"])
            assert.equal(options.mode, "node")
            if (options.mode !== "node") return
            assert.equal(options.imports.entries().get("node:crypto")?.getPath(), resolve("sha256.mjs"))
            assert.throws(() => readOptions(["--alias", "cdn=https://cdn.example/x.js", "a.test.ts"]), /--alias: a URL applies to --playwright, --webdriver and --serve only: "cdn"/)
        })

        it("reads --playwright with its browser", () => {
            const options = readOptions(["--playwright", "webkit", "suite.mjs"])
            assert.equal(options.mode, "playwright")
            if (options.mode !== "playwright") return
            assert.equal(options.browser, "webkit")
            assert.deepEqual(options.suites, [resolve("suite.mjs")])
            assert.throws(() => readOptions(["--playwright", "electron", "suite.mjs"]), /--playwright takes/)
        })

        it("reads --webdriver with its session file and endpoint, the endpoint on loopback by default", () => {
            const options = readOptions(["--webdriver", "suite.mjs"])
            assert.equal(options.mode, "webdriver")
            if (options.mode !== "webdriver") return
            assert.equal(options.session, undefined)
            assert.equal(options.endpoint, "http://127.0.0.1:4444")
            const given = readOptions(["--webdriver", "--webdriver-session", "s.json", "--endpoint", "http://127.0.0.1:9515", "suite.mjs"])
            assert.equal(given.mode, "webdriver")
            if (given.mode !== "webdriver") return
            assert.equal(given.session, "s.json")
            assert.equal(given.endpoint, "http://127.0.0.1:9515")
        })

        it("refuses two of --playwright, --webdriver and --serve", () => {
            assert.throws(() => readOptions(["--playwright", "chromium", "--serve", "suite.mjs"]), /are exclusive$/)
            assert.throws(() => readOptions(["--webdriver", "--serve", "suite.mjs"]), /are exclusive$/)
            assert.throws(() => readOptions(["--playwright", "chromium", "--webdriver", "suite.mjs"]), /are exclusive$/)
        })

        it("refuses the server's and the page's flags in Node mode", () => {
            for (const flags of [["--host", "x"], ["--port", "3000"], ["--origin", "http://x"], ["--script", "s.js"], ["--mount", "site"]]) {
                assert.throws(() => readOptions([...flags, "a.test.ts"]), /apply to --playwright, --webdriver and --serve only$/)
            }
        })

        it("refuses the WebDriver flags outside --webdriver", () => {
            assert.throws(() => readOptions(["--serve", "--webdriver-session", "s.json", "suite.mjs"]), /apply to --webdriver only$/)
            assert.throws(() => readOptions(["--playwright", "chromium", "--endpoint", "http://x", "suite.mjs"]), /apply to --webdriver only$/)
            assert.throws(() => readOptions(["--endpoint", "http://x", "a.test.ts"]), /apply to --webdriver only$/)
        })

        it("refuses a browser mode with no suite", () => {
            assert.throws(() => readOptions(["--serve"]))
            assert.throws(() => readOptions(["--playwright", "chromium", "--mount", "site"]))
        })

        it("reads several suites in a browser mode from one directory, in order, and refuses them from two", () => {
            const options = readOptions(["--serve", "test/b.mjs", "./test/a.mjs", "test/b.mjs", "test/sub/c.mjs"])
            assert.equal(options.mode, "serve")
            if (options.mode !== "serve") return
            assert.deepEqual(options.suites, [resolve("test/b.mjs"), resolve("test/a.mjs"), resolve("test/b.mjs"), resolve("test/sub/c.mjs")])
            assert.throws(() => readOptions(["--serve", "test/a.mjs", "other/b.mjs"]), /--playwright, --webdriver and --serve take the suites from one directory$/)
            assert.throws(() => readOptions(["--playwright", "chromium", "x/a.mjs", "test/b.mjs"]), /from one directory$/)
            assert.throws(() => readOptions(["--serve", "test/a/x.mjs", "test/b/y.mjs"]), /from one directory$/)
        })

        it("counts a suite's directory under a script's or an alias's as that one", () => {
            const options = readOptions(["--serve", "--alias", "lib=test/lib.mjs", "test/a/x.mjs", "test/b/y.mjs"])
            assert.equal(options.mode, "serve")
            assert.equal(readOptions(["--serve", "--script", "test/setup.js", "test/a/x.mjs", "test/b/y.mjs"]).mode, "serve")
        })

        it("lets --serve with --mount go without a suite", () => {
            const options = readOptions(["--serve", "--mount", "site"])
            assert.equal(options.mode, "serve")
            assert.deepEqual((options as {suites?: string[]}).suites, [])
            assert.equal((options as {mount?: string}).mount, resolve("site"))
        })

        it("refuses a flag it does not know, and a flag missing its value", () => {
            assert.throws(() => readOptions(["--watch", "suite.mjs"]), /--watch/)
            assert.throws(() => readOptions(["--serve", "--port"]), /--port/)
        })
    })
})
