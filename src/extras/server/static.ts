// Files for the browser test CLI's middleware chain: a directory, or one
// file, at a URL path. What @hono/node-server's serveStatic does, in the
// part a test page needs, and with the checks a test server wants: nothing
// outside the directory, and no file of a kind a page is not made of.

import {readFile, realpath, stat} from "node:fs/promises"
import {extname, resolve, sep} from "node:path"
import type {MiddlewareHandler} from "./middleware.ts"

export interface ServeStaticOptions {
    /** URL path served: a prefix ending in "/" for a directory, the exact path for a file. */
    path: string
    /** The directory or the file on disk. */
    root: string
}

const TYPES: Record<string, string> = {
    ".cjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mjs": "text/javascript",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}

const withCharset = (type: string): string => (/^text\/|[/+]json$/.test(type) ? `${type}; charset=utf-8` : type)

// A candidate file and the directory it must stay in; `base` is null for
// a file mounted by name, which is served as given.
interface Located {
    base: string | null
    path: string
}

// A resolved path that leaves the directory, through "..", is refused. A
// directory asked for by name, the mount's own or one below with a "/",
// stands for its index.html; there is no listing.
const within = (dir: string, rel: string): Located | null => {
    const base = resolve(dir)
    const path = resolve(base, rel === "" || rel.endsWith("/") ? `${rel}index.html` : rel)
    return path.startsWith(base + sep) ? {base, path} : null
}

// The check above is lexical; a symlink inside the directory could still
// point above it and readFile would follow. So the real path is checked
// against the directory's real path too, and that is what gets read. Only
// a file is served: a directory named without a "/" is not one.
const realWithin = async ({base, path}: Located): Promise<string> => {
    const real = await realpath(path)
    if (base != null && !real.startsWith((await realpath(base)) + sep)) throw new Error("outside")
    if (!(await stat(real)).isFile()) throw new Error("not a file")
    return real
}

/**
 * Serves the files under a directory, or the one file, at `path`, to GET
 * and HEAD; a directory's index.html answers for the directory. A path that
 * is not a file there goes on to the next middleware;
 * any other method on one is a 405, and a file of a kind a test page is not
 * made of, a .ts say, is a 403 rather than handed out as bytes.
 */
export const serveStatic = ({path: at, root}: ServeStaticOptions): MiddlewareHandler => async (c, next) => {
    if (c.finalized) return next()
    const {path} = c.req
    const located = at.endsWith("/")
        ? (path.startsWith(at) ? within(root, path.slice(at.length)) : null)
        : (path === at ? {base: null, path: root} : null)
    if (located == null) return next()
    let real: string
    try {
        real = await realWithin(located)
    } catch {
        return next()
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.body(null, 405, {allow: "GET, HEAD"})
    const type = TYPES[extname(located.path)]
    if (type == null) return c.body(null, 403)
    return c.body(await readFile(real), 200, {"content-type": withCharset(type)})
}
