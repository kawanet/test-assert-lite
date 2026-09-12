// An upstream at a URL path for the browser test CLI's middleware chain:
// what a request under the path asks for is fetched from there and its
// answer handed back, so a page some other server makes, an app's own
// dev server say, can carry the suites.

import type {MiddlewareHandler} from "./middleware.ts"

export interface ProxyOptions {
    /** URL path prefix ending in "/" that the upstream answers for. */
    path: string
    /** The upstream's origin and base path, ending in "/", such as http://127.0.0.1:5173/ */
    upstream: string
}

// Hop-by-hop headers belong to each connection, not to the message, and
// fetch() has undone the content encoding by the time the body is read,
// so the encoding and the length go with them; host comes from the URL.
const DROP = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length", "host"]

// As a Headers, not a record: a record has one value per name, and an
// upstream may set several cookies.
const strip = (headers: Headers): Headers => {
    const out = new Headers(headers)
    for (const name of DROP) out.delete(name)
    return out
}

/**
 * Fetches what a request under `path` asks for from `upstream` and answers
 * with what came back, status, headers and body as they are. An upstream
 * that cannot be reached is a 502; a redirect is passed on, not followed.
 */
export const proxy = ({path: at, upstream}: ProxyOptions): MiddlewareHandler => async (c, next) => {
    if (c.finalized || !c.req.path.startsWith(at)) return next()
    const {method} = c.req
    // From the URL as it came, still escaped: the decoded path is for
    // matching files, and a "#" or a "?" decoded in it would change the target.
    const {pathname, search} = new URL(c.req.url)
    const target = new URL(pathname.slice(at.length) + search, upstream)
    let res: Response
    try {
        res = await fetch(target, {
            method,
            headers: strip(c.req.raw.headers),
            body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
            // @ts-expect-error a streamed request body asks for this, which the DOM types lack
            duplex: "half",
            redirect: "manual",
        })
    } catch {
        return c.body(null, 502)
    }
    return new Response(res.body, {status: res.status, headers: strip(res.headers)})
}
