// Reads and checks the command line's arguments, apart from running any
// of them: parseArgs's flag forms, the rules that go with each mode, and
// --port's and --origin's own validation. Everything wrong throws
// UsageError here, before the caller creates anything a bad value would
// leave open; a path is resolved so the caller need not.

import {resolve} from "node:path"
import {parseArgs} from "node:util"

export const USAGE = `Usage: test-assert [options] <file...>
  --serve                     serve the suite for a browser and print the URL; the page reloads on a change
  --host <address>            address the server listens on (browser modes, default: 127.0.0.1)
  --port <number>             port the server listens on (browser modes, default: a free one)
  --origin <url>              what the browser reaches the server as, http(s)://host[:port] (browser modes, default: from --host)
  --alias <specifier>=<file>  ES module a bare specifier resolves to (browser modes, repeatable)
  --script <file>             classic script to run first (browser modes, repeatable)
  --playwright <browser>      run the suite through Playwright: chromium, firefox or webkit
  --webdriver                 run the suite through a WebDriver server: safaridriver, chromedriver
  --webdriver-session <file>  JSON sent as the body of POST /session (default: no capabilities)
  --endpoint <url>            the WebDriver server (default: http://127.0.0.1:4444)
`

const BROWSERS = ["chromium", "firefox", "webkit"] as const
export type Browser = typeof BROWSERS[number]
const isBrowser = (name: string): name is Browser => (BROWSERS as readonly string[]).includes(name)

// Wrong arguments end in the usage text and exit code 1, after the reason
// when there is one to give.
export class UsageError extends Error {
}

// A port is a whole number a socket can take; an origin is a URL that is
// nothing but scheme, host and port, as a browser names a server.
export const portOf = (value: string): number => {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port takes a number from 0 to 65535: ${value}`)
    return port
}

export const originOf = (value: string): string => {
    const error = new UsageError(`--origin takes http(s)://host[:port]: ${value}`)
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw error
    }
    if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw error
    return url.origin
}

export interface HelpOptions {
    mode: "help"
}

export interface NodeOptions {
    mode: "node"
    /** The suites, as given: node.ts resolves each against the current directory. */
    files: string[]
}

export interface BrowserOptions {
    mode: "serve" | "playwright" | "webdriver"
    /** The suite, resolved to an absolute path. */
    file: string
    /** Classic scripts, resolved, in order. */
    scripts: string[]
    /** Bare specifiers and the ES module files they resolve to, resolved. */
    aliases: {specifier: string, file: string}[]
    host?: string
    port?: number
    origin?: string
    /** Set when mode is "playwright". */
    browser?: Browser
    /** Set when mode is "webdriver" and --webdriver-session was given: the file to read, not yet read. */
    sessionFile?: string
    /** Set when mode is "webdriver". */
    endpoint?: string
}

export type Options = HelpOptions | NodeOptions | BrowserOptions

// parseArgs settles the flag forms (--x=v, -h, --) and rejects a flag this
// CLI does not know rather than taking it for a file name; its wording on
// such an error gives way to the usage text.
const parse = (args: string[]) => {
    try {
        return parseArgs({
            args,
            options: {
                serve: {type: "boolean", default: false},
                host: {type: "string"},
                port: {type: "string"},
                origin: {type: "string"},
                alias: {type: "string", multiple: true, default: []},
                script: {type: "string", multiple: true, default: []},
                playwright: {type: "string"},
                webdriver: {type: "boolean", default: false},
                "webdriver-session": {type: "string"},
                endpoint: {type: "string"},
                help: {type: "boolean", short: "h", default: false},
            },
            allowPositionals: true,
        })
    } catch {
        throw new UsageError()
    }
}

/**
 * Reads and checks the command line's arguments, and resolves to what a
 * run needs: nothing more is read from `args` once this returns, and
 * nothing it returns can be wrong in a way the caller must still guard.
 */
export const readOptions = (args: string[]): Options => {
    const {values, positionals: files} = parse(args)

    if (values.help) return {mode: "help"}

    // A browser run takes one suite: several entries would each get their
    // own mount, and a module shared between them would load once per
    // mount as a separate instance. Bundle first, as this package's are.
    const {playwright, webdriver} = values
    if (playwright != null && !isBrowser(playwright)) throw new UsageError(`--playwright takes chromium, firefox or webkit: ${playwright}`)
    const browser = playwright != null || webdriver || values.serve
    if ((playwright != null ? 1 : 0) + (webdriver ? 1 : 0) + (values.serve ? 1 : 0) > 1) {
        throw new UsageError("--playwright, --webdriver and --serve are exclusive")
    }
    if (!browser && (values.script.length || values.alias.length || values.host != null || values.port != null || values.origin != null)) {
        throw new UsageError("--host, --port, --origin, --alias and --script apply to --playwright, --webdriver and --serve only")
    }
    if (!webdriver && (values["webdriver-session"] != null || values.endpoint != null)) {
        throw new UsageError("--webdriver-session and --endpoint apply to --webdriver only")
    }
    if (browser ? files.length !== 1 : !files.length) throw new UsageError()

    if (!browser) {
        // The resolve hook only sees ESM resolution; a require() bypasses
        // it and registers with Node's own runner. Suites are ES modules,
        // so refuse the extensions that can only be CommonJS up front.
        const commonjs = files.filter(file => /\.c[jt]s$/.test(file))
        if (commonjs.length) throw new UsageError(`CommonJS suites are not supported: ${commonjs.join(", ")}`)
        return {mode: "node", files}
    }

    // Each --alias is `<specifier>=<file>`, split at the first "=".
    const aliases = values.alias.map(entry => {
        const at = entry.indexOf("=")
        if (at < 1 || at === entry.length - 1) throw new UsageError(`--alias takes <specifier>=<file>: ${entry}`)
        return {specifier: entry.slice(0, at), file: resolve(entry.slice(at + 1))}
    })

    return {
        mode: playwright != null ? "playwright" : webdriver ? "webdriver" : "serve",
        file: resolve(files[0] as string),
        scripts: values.script.map(script => resolve(script)),
        aliases,
        host: values.host,
        port: values.port == null ? undefined : portOf(values.port),
        origin: values.origin == null ? undefined : originOf(values.origin),
        browser: playwright,
        sessionFile: values["webdriver-session"],
        endpoint: values.endpoint,
    }
}
