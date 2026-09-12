import {strict as assert} from "node:assert"
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, relative, resolve, sep} from "node:path"
import {after, before, describe, it} from "node:test"
import {createFiles} from "./files.ts"

const TITLE = "extras/server/files.test.ts"

describe(TITLE, () => {
    let dir: string
    // A root as the test names it: where it sits under the fixture directory.
    const under = (root: string): string => relative(dir, root).split(sep).join("/")

    before(async () => {
        // The real path: on macOS the temporary directory is reached through a symlink, and Files serves real paths.
        dir = await realpath(await mkdtemp(join(tmpdir(), "tal-files-")))
        await mkdir(join(dir, "src", "sub"), {recursive: true})
        await mkdir(join(dir, "lib"))
        await writeFile(join(dir, "src", "a.mjs"), "")
        await writeFile(join(dir, "src", "my b.mjs"), "")
        await writeFile(join(dir, "src", "sub", "c.mjs"), "")
        await writeFile(join(dir, "lib", "mod.mjs"), "")
        await symlink(join(dir, "lib", "mod.mjs"), join(dir, "src", "link.mjs"))
    })

    after(async () => {
        await rm(dir, {recursive: true, force: true})
    })

    it("serves each file from its directory, named by nine hex digits, the same in every layout", () => {
        const one = createFiles([join(dir, "src", "a.mjs")])
        assert.deepEqual(one.dirs.map(({root}) => under(root)), ["src"])
        assert.match(one.dirs[0]?.path ?? "", /^\/@tal\/files\/[0-9a-f]{9}\/$/)
        assert.equal(one.urlOf(join(dir, "src", "a.mjs")), `${one.dirs[0]?.path}a.mjs`)
        const again = createFiles([join(dir, "src", "my b.mjs"), join(dir, "lib", "mod.mjs")])
        assert.equal(again.dirs.length, 2)
        assert.equal(again.dirOf(join(dir, "src", "my b.mjs")).path, one.dirs[0]?.path)
        assert.notEqual(again.dirOf(join(dir, "lib", "mod.mjs")).path, one.dirs[0]?.path)
        assert.equal(again.urlOf(join(dir, "src", "my b.mjs")), `${one.dirs[0]?.path}my%20b.mjs`)
    })

    it("serves a file under another's directory through that one, whatever the order", () => {
        const files = [join(dir, "src", "sub", "c.mjs"), join(dir, "src", "a.mjs"), join(dir, "lib", "mod.mjs")]
        for (const order of [files, [...files].reverse()]) {
            const laid = createFiles(order)
            assert.deepEqual(laid.dirs.map(({root}) => under(root)), ["lib", "src"])
            assert.equal(laid.urlOf(join(dir, "src", "sub", "c.mjs")), `${laid.dirOf(join(dir, "src", "a.mjs")).path}sub/c.mjs`)
        }
        const apart = createFiles([join(dir, "src", "sub", "c.mjs"), join(dir, "lib", "mod.mjs")])
        assert.deepEqual(apart.dirs.map(({root}) => under(root)), ["lib", "src/sub"])
    })

    it("serves this package's own dist/ and exports/ at the paths of their names, the IIFE's face in place of the ESM entry", () => {
        const files = createFiles([join(dir, "src", "a.mjs")])
        assert.deepEqual(files.own.map(({path}) => path), ["/@tal/dist/", "/@tal/exports/"])
        assert.equal(files.dirs.length, 1)
        assert.equal(files.urlOf(resolve("exports", "test.mjs")), "/@tal/exports/test.mjs")
        assert.equal(files.urlOf(resolve("exports", "assert", "strict.mjs")), "/@tal/exports/assert/strict.mjs")
        assert.equal(files.urlOf(resolve("dist", "test-assert-lite.min.js")), "/@tal/dist/test-assert-lite.min.js")
        assert.equal(files.urlOf(resolve("esm", "test-assert-lite.mjs")), "/@tal/exports/global.mjs")
    })

    it("takes a symlink for its target, and a file that is not there as given", () => {
        const linked = createFiles([join(dir, "src", "link.mjs"), join(dir, "lib", "mod.mjs")])
        assert.equal(linked.dirs.length, 1)
        assert.equal(linked.urlOf(join(dir, "src", "link.mjs")), linked.urlOf(join(dir, "lib", "mod.mjs")))
        const missing = createFiles([join(dir, "none", "x.mjs")])
        assert.deepEqual(missing.dirs.map(({root}) => under(root)), ["none"])
        assert.equal(missing.urlOf(join(dir, "none", "x.mjs")), `${missing.dirs[0]?.path}x.mjs`)
        assert.throws(() => missing.urlOf(join(dir, "src", "a.mjs")), /not among the files/)
    })
})
