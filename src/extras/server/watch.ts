// What --watch adds to --serve: the files the page is made of are
// watched, and a page asks at /@tal/watch whether they changed since it
// was built, the answer held back until they do. One version number
// counts the changes, so a change between the page's build and its first
// ask is not lost, and a wait that runs out is a 204 to ask again on.

import type {FSWatcher} from "node:fs"
import {watch} from "node:fs"
import {basename, dirname} from "node:path"
import {withHead} from "./head.ts"
import type {MiddlewareHandler} from "./middleware.ts"

export interface Watcher {
    /** Answers GET /@tal/watch?after=<version>: 200 once past that version, 204 when the wait runs out. */
    handler: MiddlewareHandler
    /** Puts the ask into the head of the pages the chain after it serves. */
    inject: MiddlewareHandler
    /** How many changes so far; a page is built with this and asks after it. */
    readonly version: number

    close(): void
}

// A save is several events, and an editor's atomic save a rename, so the
// directory is watched rather than the file, and a burst becomes one
// change once it has been quiet this long.
const QUIET_MS = 100

// A wait this long draws a 204 rather than an answer, so a proxy or a
// browser does not give up on the request first.
const WAIT_MS = 30_000

// What goes into the page people open: it asks after the version it was
// built with and reloads on an answer. A 204, the wait run out, means ask
// again at once; anything else, the server gone say, a second later, then
// two, then three, so a page left behind does not hammer.
const asks = (after: number): string => `<script>
(async after => {
    for (let wait = 1; ; wait++) {
        const res = await fetch(\`/@tal/watch?after=\${after}\`).catch(() => null)
        if (res?.status === 200) return location.reload()
        if (res?.status === 204) wait = 0
        await new Promise(next => setTimeout(next, wait * 1000))
    }
})(${after})
</script>
`

/**
 * Watches `files` and answers the page's asks; `wait` is how long an ask
 * is held before a 204.
 */
export const createWatcher = (files: string[], wait = WAIT_MS): Watcher => {
    let version = 0
    let quiet: ReturnType<typeof setTimeout> | null = null
    const waiting = new Set<() => void>()
    const release = (): void => {
        for (const wake of waiting) wake()
        waiting.clear()
    }

    // One watcher per directory, each told which names in it matter.
    const names = new Map<string, Set<string>>()
    for (const file of files) {
        const dir = dirname(file)
        names.set(dir, (names.get(dir) ?? new Set()).add(basename(file)))
    }
    // One at a time, so that a directory that cannot be watched, a missing
    // one say, leaves none of the earlier ones open to keep the process up.
    // An event without a name, which Node does not promise, counts as one.
    const watchers: FSWatcher[] = []
    try {
        for (const [dir, wanted] of names) {
            watchers.push(watch(dir, (_, name) => {
                if (name != null && !wanted.has(String(name))) return
                if (quiet != null) clearTimeout(quiet)
                quiet = setTimeout(() => {
                    quiet = null
                    version++
                    release()
                }, QUIET_MS)
            }))
        }
    } catch (error) {
        for (const watcher of watchers) watcher.close()
        throw error
    }

    // Resolves once past `after`, or false once the wait runs out.
    const changed = (after: number): Promise<boolean> => new Promise(resolve => {
        if (version > after) return resolve(true)
        const timer = setTimeout(() => {
            waiting.delete(wake)
            resolve(false)
        }, wait)
        timer.unref()
        const wake = (): void => {
            clearTimeout(timer)
            resolve(version > after)
        }
        waiting.add(wake)
    })

    return {
        handler: async (c, next) => {
            if (c.req.path !== "/@tal/watch") return next()
            if (c.req.method !== "GET") return c.body(null, 405, {allow: "GET"})
            const after = Number(new URL(c.req.url).searchParams.get("after") ?? "0")
            return (await changed(after))
                ? c.body(String(version), 200, {"content-type": "text/plain; charset=utf-8"})
                : c.body(null, 204)
        },
        inject: withHead(() => asks(version)),
        get version(): number {
            return version
        },
        close: () => {
            for (const watcher of watchers) watcher.close()
            if (quiet != null) clearTimeout(quiet)
            release()
        },
    }
}
