import {strict as assert} from "node:assert"
import {resolve} from "node:path"
import {describe, it} from "node:test"
import {UsageError, originOf, portOf, readOptions} from "./options.ts"

describe("extras/options", () => {
    describe("portOf", () => {
        it("takes a whole number a socket can have", () => {
            assert.equal(portOf("0"), 0)
            assert.equal(portOf("3000"), 3000)
            assert.equal(portOf("65535"), 65535)
        })

        it("refuses anything else", () => {
            // Number() trims whitespace, reads a decimal point and turns an
            // empty string into 0, so only what it cannot make a number of, or
            // an out-of-range or non-integer one, is refused.
            for (const value of ["65536", "-1", "3000.5", "abc"]) {
                assert.throws(() => portOf(value), UsageError, value)
            }
        })
    })

    describe("originOf", () => {
        it("takes scheme, host and port alone, kept as a URL would", () => {
            assert.equal(originOf("http://tal.example:3000"), "http://tal.example:3000")
            assert.equal(originOf("https://tal.example:443/"), "https://tal.example")
            assert.equal(originOf("HTTP://Tal.Example/"), "http://tal.example")
            assert.equal(originOf("http://[::1]:3000/"), "http://[::1]:3000")
            assert.equal(originOf("http://127.0.0.1:8080"), "http://127.0.0.1:8080")
        })

        it("refuses a scheme other than http(s), a path, a query, a fragment or credentials", () => {
            for (const value of ["tal.example", "tal.example:3000", "ftp://tal.example", "http://", "http://tal.example/base", "http://tal.example/?x", "http://tal.example/#f", "http://u:p@tal.example/", "http://tal.example:port"]) {
                assert.throws(() => originOf(value), UsageError, value)
            }
        })
    })

    describe("readOptions", () => {
        it("reads --help as its own mode, ahead of anything else wrong", () => {
            assert.deepEqual(readOptions(["--help"]), {mode: "help"})
            // --playwright and --webdriver together would otherwise be refused.
            assert.deepEqual(readOptions(["--help", "--playwright", "chromium", "--webdriver"]), {mode: "help"})
        })

        it("reads Node mode: the files as given, unresolved", () => {
            assert.deepEqual(readOptions(["a.test.ts", "b.test.ts"]), {mode: "node", files: ["a.test.ts", "b.test.ts"]})
        })

        it("refuses no files, and a CommonJS suite, in Node mode", () => {
            assert.throws(() => readOptions([]), UsageError)
            assert.throws(() => readOptions(["a.cjs"]), UsageError)
            assert.throws(() => readOptions(["a.cts"]), UsageError)
        })

        it("reads --serve: the suite and the scripts resolved, watch on, nothing else set", () => {
            const options = readOptions(["--serve", "suite.mjs"])
            if (options.mode !== "serve") return assert.fail(`expected mode "serve"`)
            assert.equal(options.mode, "serve")
            assert.equal(options.file, resolve("suite.mjs"))
            assert.deepEqual(options.scripts, [])
            assert.deepEqual(options.aliases, [])
            assert.equal(options.host, undefined)
            assert.equal(options.port, undefined)
            assert.equal(options.origin, undefined)
        })

        it("reads --host, --port and --origin, the latter two checked and normalized", () => {
            const options = readOptions(["--serve", "--host", "0.0.0.0", "--port", "3000", "--origin", "https://tal.example:443/", "suite.mjs"])
            if (options.mode !== "serve") return assert.fail(`expected mode "serve"`)
            assert.equal(options.host, "0.0.0.0")
            assert.equal(options.port, 3000)
            assert.equal(options.origin, "https://tal.example")
        })

        it("reads --script and --alias, resolved, and refuses a malformed --alias", () => {
            const options = readOptions(["--serve", "--script", "s.js", "--alias", "mod=m.mjs", "suite.mjs"])
            if (options.mode !== "serve") return assert.fail(`expected mode "serve"`)
            assert.deepEqual(options.scripts, [resolve("s.js")])
            assert.deepEqual(options.aliases, [{specifier: "mod", file: resolve("m.mjs")}])
            assert.throws(() => readOptions(["--serve", "--alias", "nofile", "suite.mjs"]), UsageError)
            assert.throws(() => readOptions(["--serve", "--alias", "=nospecifier", "suite.mjs"]), UsageError)
        })

        it("reads --playwright: the browser name checked, no --webdriver fields set", () => {
            const options = readOptions(["--playwright", "chromium", "suite.mjs"])
            if (options.mode !== "playwright") return assert.fail(`expected mode "playwright"`)
            assert.equal(options.mode, "playwright")
            assert.equal(options.browser, "chromium")
            assert.equal(options.sessionFile, undefined)
            assert.equal(options.endpoint, undefined)
            assert.throws(() => readOptions(["--playwright", "electron", "suite.mjs"]), UsageError)
        })

        it("reads --webdriver: the session file and the endpoint as given, unread", () => {
            const options = readOptions(["--webdriver", "--webdriver-session", "s.json", "--endpoint", "http://127.0.0.1:4444", "suite.mjs"])
            if (options.mode !== "webdriver") return assert.fail(`expected mode "webdriver"`)
            assert.equal(options.mode, "webdriver")
            assert.equal(options.browser, undefined)
            assert.equal(options.sessionFile, "s.json")
            assert.equal(options.endpoint, "http://127.0.0.1:4444")
        })

        it("refuses --playwright, --webdriver and --serve together", () => {
            assert.throws(() => readOptions(["--playwright", "chromium", "--serve", "suite.mjs"]), UsageError)
            assert.throws(() => readOptions(["--webdriver", "--serve", "suite.mjs"]), UsageError)
        })

        it("refuses --host, --port, --origin, --alias and --script outside a browser mode", () => {
            for (const flag of [["--host", "x"], ["--port", "3000"], ["--origin", "http://x"], ["--alias", "a=b"], ["--script", "s.js"]]) {
                assert.throws(() => readOptions([...flag, "suite.test.ts"]), UsageError, flag[0])
            }
        })

        it("refuses --webdriver-session and --endpoint outside --webdriver", () => {
            assert.throws(() => readOptions(["--serve", "--webdriver-session", "s.json", "suite.mjs"]), UsageError)
            assert.throws(() => readOptions(["--playwright", "chromium", "--endpoint", "http://x", "suite.mjs"]), UsageError)
        })

        it("refuses several files in a browser mode, and none", () => {
            assert.throws(() => readOptions(["--serve", "a.mjs", "b.mjs"]), UsageError)
            assert.throws(() => readOptions(["--serve"]), UsageError)
        })

        it("refuses a flag it does not know", () => {
            assert.throws(() => readOptions(["--nope"]), UsageError)
        })
    })
})
