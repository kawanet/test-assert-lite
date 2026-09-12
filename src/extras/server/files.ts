// The files the browser test application serves, by directory. This
// package's own, dist/ and exports/, go out as the package lays them out;
// every other directory is named by a digest of it, so that the same one
// gets the same URL in every run and the path itself stays off the page. A
// directory under another one served is not mounted on its own: its files
// are reached through the ancestor, so a module two files share is one
// URL, hence one instance, as it is one file under Node.

import {createHash} from "node:crypto"
import {realpathSync} from "node:fs"
import {dirname, relative, resolve, sep} from "node:path"
import {fileURLToPath} from "node:url"
import {packageRoot} from "../package-root.ts"

export interface Dir {
    /** The URL path, `/@tal/<dir>/` for this package's own, `/@tal/files/<name>/` otherwise. */
    path: string
    /** The directory, absolute and real. */
    root: string
}

export interface Files {
    /** This package's own directories, dist/ and exports/, at the paths of their names. */
    own: Dir[]
    /** The directories the files are served from, in path order, so one before those under it. */
    dirs: Dir[]
    /** The directory one of the files is served from. */
    dirOf(file: string): Dir
    /** The URL a page refers to one of the files by, percent-encoded. */
    urlOf(file: string): string
}

// A file as the browser will identify it: its real path, so a symlink and
// its target are one file; a file that is not there stays as given and
// will be a 404 rather than an error here.
const realOf = (file: string): string => {
    try {
        return realpathSync(file)
    } catch {
        return resolve(file)
    }
}

// Nine hex digits of the directory's digest: the width of a run's id.
const nameOf = (dir: string): string => createHash("sha256").update(dir).digest("hex").slice(0, 9)

// This package's own directories, at the paths of their names. The ESM
// entry is the one file a browser must not get: the IIFE's face, the ES
// module on the global the IIFE leaves, stands in for it.
const own = fileURLToPath(packageRoot())
const OWN: Dir[] = [
    {path: "/@tal/dist/", root: realOf(resolve(own, "dist"))},
    {path: "/@tal/exports/", root: realOf(resolve(own, "exports"))},
]
const STAND_IN = new Map([[realOf(resolve(own, "esm", "test-assert-lite.mjs")), realOf(resolve(own, "exports", "global.mjs"))]])

/**
 * Lays out the directories the files are served from: every file's own,
 * except one inside another's, which is served through that one. The
 * order the files come in makes no difference to the layout.
 */
export const createFiles = (files: string[]): Files => {
    const reals = new Map(files.map(file => [file, realOf(file)]))
    // Sorted, a directory comes before the ones under it, as a prefix does.
    const names = [...new Set([...reals.values()].map(real => dirname(real)))].sort()
    const dirs: Dir[] = []
    const within = (dir: string): Dir | undefined => [...OWN, ...dirs].find(({root}) => dir === root || dir.startsWith(root + sep))
    for (const dir of names) {
        if (within(dir) == null) dirs.push({path: `/@tal/files/${nameOf(dir)}/`, root: dir})
    }
    const servedAs = (file: string): string => {
        const real = reals.get(file) ?? realOf(file)
        return STAND_IN.get(real) ?? real
    }
    const dirOf = (file: string): Dir => {
        const dir = within(dirname(servedAs(file)))
        if (dir == null) throw new Error(`not among the files laid out: ${file}`)
        return dir
    }
    const urlOf = (file: string): string => {
        const dir = dirOf(file)
        return dir.path + relative(dir.root, servedAs(file)).split(sep).map(encodeURIComponent).join("/")
    }
    return {own: OWN, dirs, dirOf, urlOf}
}
