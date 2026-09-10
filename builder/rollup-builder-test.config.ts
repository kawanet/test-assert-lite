import alias from "@rollup/plugin-alias"
import multiEntry from "@rollup/plugin-multi-entry"
import sucrase from "@rollup/plugin-sucrase"
import type {RollupOptions} from "rollup"
import {showFiles} from "./show-files.ts"

// Self-eating build: the suites are written against `node:test` and
// `node:assert`, and the CLI that runs this bundle points both at the
// package itself through a resolve hook, so they stay as written here and
// the bundle exercises the library with the library.
const rollupConfig: RollupOptions = {
    // src/extras/ and src/server/ tests exercise Node-only code such as the HTTP server, and
    // this bundle runs under the package's own CLI, so they stay out.
    input: ["../src/**/*.test.ts", "!../src/extras/*", "!../src/server/*", "!../src/reporter/client.test.ts", "!../src/reporter/heartbeat.test.ts"],

    // Left to the CLI's hook, plus the builtins a suite reaches for
    // directly. Listed by name rather than by pattern so the alias below
    // still sees the relative entry imports first.
    external: [
        "test-assert-lite",
        "test-assert-lite/assert",
        "test-assert-lite/assert/strict",
        "test-assert-lite/test",
        "node:assert",
        "node:assert/strict",
        "node:module",
        "node:path",
        "node:test",
    ],

    output: {
        file: "./tests/bundled.mjs",
        format: "esm",
    },

    // Registration happens through side effects only. With tree shaking on,
    // rollup removes every describe() and it() call as unreachable.
    treeshake: false,

    plugins: [
        // The suites reach the subject by relative path so they run on the
        // sources directly under `node --test`. Only the entry is matched,
        // whatever directory the suite sits in: anything else stays inlined,
        // which is what src/test-utils/ needs.
        alias({
            entries: [
                {find: /^(\.\.?\/)+index\.ts$/, replacement: "test-assert-lite"},
            ],
        }),

        multiEntry(),

        sucrase({
            disableESTransforms: true,
            exclude: ["node_modules/**"],
            transforms: ["typescript"],
        }),

        showFiles(),
    ],
}

export default rollupConfig
