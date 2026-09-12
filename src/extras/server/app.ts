// The browser test application: what to serve and where, for the suites, as
// one middleware in the shape of a Hono handler. It lays out the mounts,
// builds the import map, puts it into the pages and chains them with the
// channel to the page; the server that runs it is another's, serve.ts today.
// The CLI turns arguments into AppOptions; anything else could do the same.

import {basename, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {Imports} from "../imports.ts"
import {packageNameOf, packageRoot} from "../package-root.ts"
import type {ChannelOptions} from "./channel.ts"
import {createChannel} from "./channel.ts"
import {createFiles} from "./files.ts"
import {hasImportMap, withHead} from "./head.ts"
import type {MiddlewareHandler} from "./middleware.ts"
import {compose, scoped} from "./middleware.ts"
import {proxy} from "./proxy.ts"
import {serveStatic} from "./static.ts"
import {withTitle} from "./title.ts"
import type {Watcher} from "./watch.ts"
import {createWatcher} from "./watch.ts"

export interface AppOptions extends ChannelOptions {
    /** The suites, absolute, all served from one directory. Without any, the pages carry the library and no suite. */
    suites?: string[]
    /** Classic scripts to run before the suites, absolute, in this order. */
    scripts?: string[]
    /** Specifiers and what they resolve to: a file, served from its directory, or a URL put into the map as it is. */
    imports?: Imports
    /** What the root serves in place of htdocs: an absolute directory, or an http(s) URL ending in "/" to proxy. */
    mount?: string
    /** Reloads the page people open when a suite, a script or an imported file changes; off where it cannot watch. */
    watch?: boolean
}

export interface App {
    /** Serves it all: the pages, the mounts and the channel to the page. */
    handler: MiddlewareHandler
    /** Path of the page a browser is sent to, under the run's own path. */
    page: string
    /** The verdict the page reports at its end; rejects if it never begins. */
    done: Promise<boolean>
    /** Stops waiting for the page. */
    close(): void
}

// The package root holds the pages, htdocs/ and browser/run.html; they
// are served from there whatever the suite's location.
const root = fileURLToPath(packageRoot())

/**
 * Builds the application for the suites: its middleware, and the promise
 * of the verdict the page at `page` reports back through it.
 */
export const createApp = (options: AppOptions): App => {
    const {suites = [], scripts = [], imports = new Imports([]), mount: mounted, stderr = text => process.stderr.write(text)} = options
    const channel = createChannel(options)

    // Watching is a convenience of --serve, not what it is for: where the
    // file system refuses, the inotify limit reached say, the page is
    // served all the same, without the reload, and stderr says why once.
    let watcher: Watcher | null = null
    if (options.watch) {
        try {
            watcher = createWatcher([...suites, ...scripts, ...imports.paths()])
        } catch (error) {
            stderr(`watch is off: ${error instanceof Error ? error.message : String(error)}\n`)
        }
    }

    // Every file given is served from its directory under /@tal/files/, so
    // a sibling or a nested import resolves beside it while nothing above
    // stays reachable; the suites' directory is the same for all of them.
    const served = createFiles([...suites, ...scripts, ...imports.paths()])

    // The build browsers get is the IIFE, so that is what runs: it goes in
    // as the first classic script; the package's name in the map leads to
    // the ES module face of its global, in place of the ESM build.
    const scriptUrls = [served.urlOf(resolve(root, "dist", "test-assert-lite.min.js")), ...scripts.map(script => served.urlOf(script))]

    // The map has to be inline and in place before the first module loads;
    // classic script tags run in order as the head is parsed, and module
    // tags in order once it is, the suites in the order given as under
    // Node, ahead of the page's own module in the body that calls run(). So
    // all three go into the head of every HTML page served from htdocs/,
    // and of the run's page, as it goes out.
    const importmap = `<script type="importmap">\n${JSON.stringify({imports: imports.addresses(file => served.urlOf(file))}, null, 4)}\n</script>\n`
    const tags = scriptUrls.map(url => `<script src="${url}"></script>\n`).join("")
        + suites.map(suite => `<script type="module" src="${served.urlOf(suite)}"></script>\n`).join("")
    // A page with an import map of its own goes out as it is: a second map
    // is not for a browser, and without this one the suites cannot load,
    // so the scripts and the suites stay out too. stderr says so.
    const head = withHead((html, path) => {
        if (!hasImportMap(html)) return importmap + tags
        stderr(`import map of its own, left as it is: ${path}\n`)
        return ""
    })

    // Two pages get the head: the root's HTML, with the reload ask under
    // watch, and the run's page, without it. Each is a scoped chain so the
    // head touches nothing served after it, /@tal/ least of all: the build
    // and the bridges have to stay as the package ships them.
    const atRoot = mounted == null
        ? serveStatic({path: "/", root: resolve(root, "htdocs")})
        : /^https?:\/\//i.test(mounted) ? proxy({path: "/", upstream: mounted}) : serveStatic({path: "/", root: mounted})

    // The CLI's own pages are named after what they run: the package each
    // suite belongs to, or the suite's own name where there is none.
    const names = suites.map(suite => packageNameOf(suite) ?? basename(suite))
    const title = withTitle([...new Set(names)].join(" ") || "test-assert-lite")
    const handler = compose([
        channel.handler,
        ...(watcher == null ? [] : [watcher.handler]),
        scoped(compose([head, title, serveStatic({path: `${channel.path}run.html`, root: resolve(root, "browser", "run.html")})])),
        ...[...served.own, ...served.dirs].map(dir => serveStatic(dir)),
        // /@tal/ is the CLI's: what none of the mounts above answered ends
        // here, whatever a mount or an upstream at the root would say to it.
        async (c, next) => (c.req.path.startsWith("/@tal/") ? c.notFound() : next()),
        scoped(compose([...(watcher == null ? [] : [watcher.inject]), head, ...(mounted == null ? [title] : []), atRoot])),
    ])

    return {
        handler,
        page: `${channel.path}run.html`,
        done: channel.done,
        close: () => {
            channel.close()
            watcher?.close()
        },
    }
}
