// The command line as a function: readOptions() turns the arguments into
// what a run needs, or throws before anything below runs; this file only
// executes what it returns. By default the suites run in this Node
// process; --playwright runs them in one of Playwright's headless
// browsers, --webdriver in whatever browser a WebDriver server drives,
// and --serve hands the same page to a person.

import {readFileSync} from "node:fs"
import {createApp} from "../server/app.ts"
import {serve} from "../server/serve.ts"
import {runInNode} from "./node.ts"
import type {Browser, Options} from "./options.ts"
import {USAGE, UsageError, readOptions} from "./options.ts"
import {runInPlaywright} from "./playwright.mjs"
import {runInWebDriver} from "./webdriver.ts"

export interface CLIOptions {
    /** The arguments as the executable gets them: process.argv.slice(2). */
    args: string[]
}

const run = async (options: Options): Promise<number> => {
    if (options.mode === "help") {
        process.stdout.write(USAGE)
        return 0
    }

    if (options.mode === "node") {
        return (await runInNode(options.files)).success ? 0 : 1
    }

    // The application is the middleware, the server runs it; every request
    // goes to stderr, apart from the reporter's stdout, so a 404 for a
    // mistyped --script or --alias shows up there.
    const app = createApp({
        file: options.file,
        scripts: options.scripts,
        aliases: options.aliases,
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
                session: options.sessionFile == null ? undefined : readFileSync(options.sessionFile, "utf8"),
                endpoint: options.endpoint ?? "http://127.0.0.1:4444",
            })
            : await runInPlaywright({
                page,
                done: app.done,
                browser: options.browser as Browser,
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
    try {
        return await run(readOptions(args))
    } catch (error: unknown) {
        if (!(error instanceof UsageError)) throw error
        if (error.message) process.stderr.write(`${error.message}\n`)
        process.stderr.write(USAGE)
        return 1
    }
}
