import alias from "@rollup/plugin-alias"
import commonjs from "@rollup/plugin-commonjs"
import multiEntry from "@rollup/plugin-multi-entry"
import nodeResolve from "@rollup/plugin-node-resolve"
import sucrase from "@rollup/plugin-sucrase"
import {fileURLToPath} from "node:url"
import type {RollupOptions} from "rollup"
import {showFiles} from "./show-files.ts"

// Bundles the test suites for browser/tests.html. The suites are written
// against node:test and node:assert, and this package is what stands in for
// those in a browser, so both resolve to the global left behind by
// dist/*.min.js -- the same self-eating arrangement as the Node bundle,
// which is why no shim modules are needed here.
const rollupConfig: RollupOptions = {
    // The 9x suites pin the Node entry surface, package name and require()
    // included; the browser one is checked by builder/pack test-iife, so the
    // negative pattern keeps them out here.
    input: ["../src/**/*.test.ts", "!../src/9?.*"],

    output: {
        file: "../browser/tests/bundled.js",
        format: "iife",
    },

    treeshake: false,

    plugins: [
        // Every entry resolves to the real module under `node --test` and to
        // browser/import.js here. The list is a whitelist: anything absent
        // stays inlined, which is what a helper such as src/test-utils/
        // needs.
        alias({
            entries: [
                {find: "node:test", replacement: fileURLToPath(new URL("../browser/import.js", import.meta.url))},
                {find: "node:assert", replacement: fileURLToPath(new URL("../browser/import.js", import.meta.url))},
                {find: "./index.ts", replacement: fileURLToPath(new URL("../browser/import.js", import.meta.url))},
                // Spelling from a suite one directory down; same target.
                {find: "./../index.ts", replacement: fileURLToPath(new URL("../browser/import.js", import.meta.url))},
            ],
        }),

        multiEntry(),

        nodeResolve({
            browser: true,
            preferBuiltins: false,
        }),

        // Required so rollup can read browser/import.js's `exports.x = x`
        // syntax. The file stays CJS so browserify users can consume the
        // same glue.
        commonjs(),

        sucrase({
            disableESTransforms: true,
            exclude: ["node_modules/**"],
            transforms: ["typescript"],
        }),

        showFiles(),
    ],
}

export default rollupConfig
