import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import type {MiddlewareHandler} from "./middleware.ts"
import {compose, createContext} from "./middleware.ts"
import {withTitle} from "./title.ts"

const through = async (name: string, body: string, type = "text/html", status = 200): Promise<string> => {
    const answer: MiddlewareHandler = async c => c.body(body, status, {"content-type": type})
    const c = createContext(new Request("http://127.0.0.1/page.html"))
    await compose([withTitle(name), answer])(c, async () => undefined)
    return c.res.text()
}

describe("server/title", () => {
    it("puts the name between the tags that hold the placeholder, escaped, and nowhere else", async () => {
        const out = await through("a <b> & 'c'", "<title>{{title}}</title><h1>{{title}}</h1><p title=\"{{title}}\">{{title}}x</p>")
        assert.equal(out, "<title>a &#60;b&#62; &#38; &#39;c&#39;</title><h1>a &#60;b&#62; &#38; &#39;c&#39;</h1><p title=\"{{title}}\">{{title}}x</p>")
    })

    it("leaves anything but a 200 text/html answer as it came", async () => {
        assert.equal(await through("x", "<b>{{title}}</b>", "text/plain"), "<b>{{title}}</b>")
        assert.equal(await through("x", "<b>{{title}}</b>", "text/html", 404), "<b>{{title}}</b>")
    })
})
