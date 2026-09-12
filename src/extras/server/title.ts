// Names the CLI's own pages after what they run. The pages carry a
// placeholder between tags; nothing else is looked at, and a page the
// CLI does not own never meets this.

import type {MiddlewareHandler} from "./middleware.ts"

const escape = (text: string): string => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/**
 * After the rest of the chain, puts `name` in place of every `>{{title}}<`
 * in a 200 text/html Response, escaped for HTML. Any other Response goes
 * out as it came.
 */
export const withTitle = (name: string): MiddlewareHandler => async (c, next) => {
    await next()
    const {status, headers} = c.res
    if (status !== 200 || !headers.get("content-type")?.startsWith("text/html")) return
    const html = await c.res.text()
    c.res = new Response(html.replaceAll(">{{title}}<", `>${escape(name)}<`), {status, headers})
}
