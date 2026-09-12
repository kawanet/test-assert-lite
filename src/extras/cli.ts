// The command line as a function: options.ts reads the arguments, and
// this runs what they ask for. By default the suites run in this Node
// process; --playwright runs them in one of Playwright's headless
// browsers, --webdriver in whatever browser a WebDriver server drives,
// and --serve hands the same page to a person. Directory search and glob
// expansion are left to the shell: only explicit file names are accepted.

import {readFileSync} from "node:fs"
import {stringify} from "../utils/stringify.ts"
import {VERSION} from "../utils/version.ts"
import {runInNode} from "./drivers/node.ts"
import {runInPlaywright} from "./drivers/playwright.mjs"
import {runInWebDriver} from "./drivers/webdriver.ts"
import type {Options} from "./options.ts"
import {readOptions, USAGE} from "./options.ts"
import {createApp} from "./server/app.ts"
import {serve} from "./server/serve.ts"

export interface CLIOptions {
    /** The arguments as the executable gets them: process.argv.slice(2). */
    args: string[]
}

const runCLI = async (options: Options): Promise<number> => {
    if (options.mode === "help") {
        process.stdout.write(USAGE)
        return 0
    }
    if (options.mode === "version") {
        process.stdout.write(`test-assert-lite ${VERSION}\n`)
        return 0
    }

    if (options.mode === "node") {
        return (await runInNode(options.suites, options.imports)).success ? 0 : 1
    }

    // The application is the middleware, the server runs it; every request
    // goes to stderr, apart from the reporter's stdout, so a 404 for a
    // mistyped --script or --alias shows up there.
    const app = createApp({
        suites: options.suites,
        scripts: options.scripts,
        imports: options.imports,
        mount: options.mount,
        watch: options.mode === "serve",
    })
    // A server that cannot listen, its port taken say, is an error to show;
    // the application, with its watch, must not keep the process up for it.
    const server = await serve({
        handler: app.handler,
        host: options.host,
        port: options.port,
        origin: options.origin,
        log: line => process.stderr.write(`${line}\n`),
    }).catch((error: unknown) => {
        app.close()
        throw error
    })
    const page = `${server.origin}${app.page}`
    const close = (): void => {
        app.close()
        server.close()
    }

    if (options.mode === "serve") {
        // Only the URL goes to stdout, so it can be piped. The server keeps
        // the process alive until an interrupt, which resolves this.
        process.stdout.write(`${server.origin}/\n`)
        process.stderr.write("Serving the suite; press Ctrl-C to stop.\n")
        await new Promise<void>(stop => process.once("SIGINT", () => stop()))
        close()
        return 0
    }

    try {
        const success = options.mode === "webdriver"
            ? await runInWebDriver({
                page,
                done: app.done,
                session: options.session == null ? undefined : readFileSync(options.session, "utf8"),
                endpoint: options.endpoint,
            })
            : await runInPlaywright({
                page,
                done: app.done,
                browser: options.browser,
            })

        // The exit code alone, as in Node mode and node --test: the summary
        // on stdout already says what failed, and no tests is not a failure.
        return success ? 0 : 1
    } finally {
        close()
    }
}

/**
 * Runs the command line with `args` and resolves to its exit code. Writes
 * what the command line writes, and rejects with what it could not handle,
 * but never exits the process: that is the executable's part. Meant for
 * one call per process, as the command line is: Node mode installs a
 * resolve hook that stays, and a suite once loaded is not loaded again.
 */
export const CLI = async ({args}: CLIOptions): Promise<number> => {
    let options: ReturnType<typeof readOptions>

    try {
        options = readOptions(args)
    } catch (error) {
        const message = !!error && stringify(error)
        if (message) process.stderr.write(`${message}\n`)
        process.stderr.write(USAGE)
        return 2 // EXIT_USAGE
    }

    return await runCLI(options)
}
