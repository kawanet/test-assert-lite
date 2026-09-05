import alias from "@rollup/plugin-alias"
import sucrase from "@rollup/plugin-sucrase"
import {fileURLToPath} from "node:url"
import type {RollupOptions} from "rollup"
import {showFiles} from "./show-files.ts"

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

// The main bundle stays external so that every subpath shares its one
// default harness: what `test-assert-lite/test` registers is what
// `test-assert-lite` runs.
const main = here("../dist/test-assert-lite.mjs")

// Subpath entries mirroring the Node builtins they stand in for. Each is a
// thin re-export, built once as ESM and once as CommonJS glue.
const rollupConfig: RollupOptions = {
    input: {
        "test": "../src/exports/test.ts",
        "assert": "../src/exports/assert.ts",
        "assert-strict": "../src/exports/assert-strict.ts",
    },

    external: [main],

    // Both outputs land beside the bundles, so the import is spelled as a
    // sibling rather than left as the absolute path the alias resolved to.
    output: [
        {
            dir: "../dist",
            format: "esm",
            entryFileNames: "[name].mjs",
            paths: {[main]: "./test-assert-lite.mjs"},
        },
        {
            // Below Node 20.19 require() cannot load the .mjs, so the CommonJS
            // glue reaches the minified build, which doubles as a CJS module.
            dir: "../dist",
            format: "cjs",
            entryFileNames: "[name].cjs",
            exports: "auto",
            paths: {[main]: "./test-assert-lite.min.js"},
        },
    ],

    plugins: [
        // The entries import the sources by relative path so that tsc and
        // `node --test` see them; the build points that at the main bundle.
        alias({
            entries: [
                {find: /^(\.\.\/)+index\.ts$/, replacement: main},
            ],
        }),

        sucrase({
            disableESTransforms: true,
            exclude: ["node_modules/**"],
            transforms: ["typescript"],
        }),

        showFiles(),
    ],
}

export default rollupConfig
