// The command line's arguments, read apart from what runs them: the flags
// as parseArgs settles them, the rules each mode brings, and the form a
// value has to take. Anything wrong is a UsageError from here, before the
// caller has opened a server or a watch on the strength of it.

import {resolve} from "node:path"
import {parseArgs} from "node:util"
import type {Mode} from "./imports.ts"
import {ImportAliasItem, Imports, cwdURL, readImportMap} from "./imports.ts"
import {createFiles} from "./server/files.ts"
import {UsageError} from "./usage-error.ts"

export const USAGE = `Usage: test-assert [options] <file...>
  -v, --version               print this package's version
  --alias <specifier>=<file>  what a specifier resolves to: a file, a URL for the page, or this package's own name (repeatable)
  --import-map <file>         JSON import map: a relative address is a file beside it, / and http(s):// go to the page as they are
  --serve                     serve the suite for a browser and print the URL; the page reloads on a change
  --host <address>            address the server listens on (browser modes, default: 127.0.0.1)
  --port <number>             port the server listens on (browser modes, default: a free one)
  --origin <url>              what the browser reaches the server as, http(s)://host[:port] (browser modes, default: from --host)
  --script <file>             classic script to run first (browser modes, repeatable)
  --mount <dir|url>           what the root serves instead of htdocs: a directory, or an origin to proxy (browser modes)
  --webdriver                 run the suite through a WebDriver server: safaridriver, chromedriver
  --webdriver-session <file>  JSON sent as the body of POST /session (default: no capabilities)
  --endpoint <url>            the WebDriver server (default: http://127.0.0.1:4444)
  --playwright <browser>      run the suite through Playwright: chromium, firefox or webkit
`

const BROWSERS = ["chromium", "firefox", "webkit"] as const
export type Browser = typeof BROWSERS[number]

// What the three browser modes share: the suites, what the page is made
// of, and where the server sits. --serve with --mount may go without a
// suite: the mounted pages carry the library then, and whatever they run.
export interface BrowserOptions {
    /** The suites, absolute, all served from one directory; none only under --serve with --mount. */
    suites: string[]
    /** Classic scripts to run first, absolute, in order. */
    scripts: string[]
    /** From --import-map then --alias, a later item over an earlier one of the same specifier. */
    imports: Imports
    /** What the root serves in place of htdocs: an absolute directory, or an http(s) URL ending in "/". */
    mount?: string
    host?: string
    port?: number
    origin?: string
}

export type Options =
    | {mode: "help"}
    | {mode: "version"}
    | {mode: "node", suites: string[], imports: Imports}
    | BrowserOptions & {mode: "serve"}
    | BrowserOptions & {mode: "playwright", browser: Browser}
    | BrowserOptions & {mode: "webdriver", session?: string, endpoint: string}

// A port is a whole number a socket can take, written in decimal: what
// Number() would also read, 0x50 or 1e3 or nothing, is not one.
export const portOf = (value: string): number => {
    const port = Number(value)
    if (!/^\d+$/.test(value) || port > 65535) throw new UsageError(`--port takes a number from 0 to 65535: ${value}`)
    return port
}

// An origin is a URL that is nothing but scheme, host and port, as a
// browser names a server.
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

// A mount is a directory, resolved, or an http(s) URL to proxy, taken
// as given up to its path and made to end in "/" so a request's path
// joins onto it.
export const mountOf = (value: string): string => {
    if (!/^https?:\/\//i.test(value)) return resolve(value)
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new UsageError(`--mount takes a directory or http(s)://host[:port][/path]: ${value}`)
    }
    if (url.search || url.hash || url.username || url.password) throw new UsageError(`--mount takes a directory or http(s)://host[:port][/path]: ${value}`)
    return url.href.endsWith("/") ? url.href : `${url.href}/`
}

// The import map's items first and each --alias after, so the command
// line has the last word; what `mode` cannot take of the result is refused
// here, one reason per specifier, before anything is served or hooked.
export const importsOf = (mapFile: string | undefined, aliases: string[], mode: Mode): Imports => {
    const imports = new Imports([...(mapFile == null ? [] : readImportMap(resolve(mapFile))), ...aliases.map(entry => new ImportAliasItem(entry, cwdURL()))])
    const refusals = imports.refusals(mode)
    if (refusals.length) throw new UsageError(refusals.join("\n"))
    return imports
}

export const browserOf = (name: string): Browser => {
    if (!(BROWSERS as readonly string[]).includes(name)) throw new UsageError(`--playwright takes chromium, firefox or webkit: ${name}`)
    return name as Browser
}

// parseArgs settles the flag forms (--x=v, -h, --) and rejects a flag this
// CLI does not know rather than taking it for a file name. What it says
// becomes the reason, ahead of the usage text, in node's own wording.
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
                "import-map": {type: "string"},
                script: {type: "string", multiple: true, default: []},
                mount: {type: "string"},
                playwright: {type: "string"},
                webdriver: {type: "boolean", default: false},
                "webdriver-session": {type: "string"},
                endpoint: {type: "string"},
                help: {type: "boolean", short: "h", default: false},
                version: {type: "boolean", short: "v", default: false},
            },
            allowPositionals: true,
        })
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
    }
}

/**
 * Reads the arguments as the executable gets them and returns what the
 * mode they name needs, every value checked and every path absolute, or
 * throws UsageError with the reason when there is one to give.
 */
export const readOptions = (args: string[]): Options => {
    const {values, positionals: files} = parse(args)
    if (values.help) return {mode: "help"}
    if (values.version) return {mode: "version"}

    const {playwright, webdriver, serve} = values
    const browser = playwright == null ? undefined : browserOf(playwright)
    const browsing = browser != null || webdriver || serve
    if ((browser != null ? 1 : 0) + (webdriver ? 1 : 0) + (serve ? 1 : 0) > 1) {
        throw new UsageError("--playwright, --webdriver and --serve are exclusive")
    }
    if (!browsing && (values.script.length || values.mount != null || values.host != null || values.port != null || values.origin != null)) {
        throw new UsageError("--host, --port, --origin, --script and --mount apply to --playwright, --webdriver and --serve only")
    }
    if (!webdriver && (values["webdriver-session"] != null || values.endpoint != null)) {
        throw new UsageError("--webdriver-session and --endpoint apply to --webdriver only")
    }
    const optional = serve && values.mount != null
    if (!files.length && !(browsing && optional)) throw null

    // Suites are ES modules: under Node a require() bypasses the hook and
    // lands on Node's own runner, and a browser has no require at all, so
    // the extensions that can only be CommonJS are refused in both. A
    // browser strips no types either, so TypeScript is refused there too.
    const commonjs = files.filter(file => /\.c[jt]s$/.test(file))
    if (commonjs.length) throw new UsageError(`CommonJS suites are not supported: ${commonjs.join(", ")}`)
    if (browsing) {
        const typescript = [...files, ...values.script].filter(file => /\.[cm]?ts$/.test(file))
        if (typescript.length) throw new UsageError(`a browser runs no TypeScript: ${typescript.join(", ")}`)
    }

    const imports = importsOf(values["import-map"], values.alias, browsing ? "browser" : "node")
    if (!browsing) return {mode: "node", suites: files.map(file => resolve(file)), imports}

    const suites = files.map(file => resolve(file))
    const scripts = values.script.map(script => resolve(script))

    // The suites are served from one directory, so a module they share is
    // one URL and loads once, as under Node; from two, it would load once
    // per directory. One under another counts as served from the latter.
    const served = createFiles([...suites, ...scripts, ...imports.paths()])
    if (new Set(suites.map(file => served.dirOf(file))).size > 1) {
        throw new UsageError("--playwright, --webdriver and --serve take the suites from one directory")
    }

    const shared: BrowserOptions = {
        suites: suites,
        scripts,
        imports,
        mount: values.mount == null ? undefined : mountOf(values.mount),
        host: values.host,
        port: values.port == null ? undefined : portOf(values.port),
        origin: values.origin == null ? undefined : originOf(values.origin),
    }
    if (browser != null) return {...shared, mode: "playwright", browser}
    if (webdriver) return {...shared, mode: "webdriver", session: values["webdriver-session"], endpoint: values.endpoint ?? "http://127.0.0.1:4444"}
    return {...shared, mode: "serve"}
}
