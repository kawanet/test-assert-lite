import json from "@rollup/plugin-json"
import alias from "@rollup/plugin-alias"
import multiEntry from "@rollup/plugin-multi-entry"
import nodeResolve from "@rollup/plugin-node-resolve"
import sucrase from "@rollup/plugin-sucrase"
import type {RollupOptions} from "rollup"
import {showFiles} from "./show-files.ts"

const shouldBundled = [
    "multi-entry.js",
    "event-lite",
]

const rollupConfig: RollupOptions = {
    input: ["../src/**/*.test.ts", "!../src/extras/*"],

    // Bare specifiers stay external; only relative paths are bundled.
    external: v => /^[^./]/.test(v) && !shouldBundled.includes(v),

    output: {
        file: "./tests/bundled.mjs",
        format: "esm",
    },

    // Registration happens through side effects only. With tree shaking on,
    // rollup removes every describe() and it() call as unreachable.
    treeshake: false,

    plugins: [
        json(),

        alias({
            entries: [
                {find: /^(\.\.?\/)+index\.ts$/, replacement: "test-assert-lite"},
            ],
        }),

        nodeResolve({
            browser: true,
            preferBuiltins: false,
        }),

        multiEntry(),

        sucrase({
            disableESTransforms: true,
            exclude: ["node_modules/**"],
            transforms: ["typescript"],
        }),

        showFiles({deny: /\W(extras)\W/, gray: /\W(test)(?!-assert)\W/}),
    ],
}

export default rollupConfig
