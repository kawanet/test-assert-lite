import alias from "@rollup/plugin-alias"
import multiEntry from "@rollup/plugin-multi-entry"
import sucrase from "@rollup/plugin-sucrase"
import type {RollupOptions} from "rollup"
import {showFiles} from "./show-files.ts"

// Bundles the test suites for the browser as one ES module. node:test and
// node:assert stay as written: the page the CLI serves
// carries an import map that points them, and the package name, at the
// ESM build, so no glue module is inlined here.
const rollupConfig: RollupOptions = {
    // 90.entrypoint pins the Node entry surface; the browser one is checked
    // by builder/pack test-iife, so the negative pattern keeps it out here.
    // src/extras/ and src/server/ tests exercise Node-only code such as the HTTP server.
    input: ["../src/**/*.test.ts", "!../src/90.*", "!../src/extras/*", "!../src/server/*", "!../src/reporter/client.test.ts", "!../src/reporter/heartbeat.test.ts"],

    // Left to the import map. Listed by name rather than by pattern so the
    // alias below still sees the relative entry imports first.
    external: [
        "test-assert-lite",
        "test-assert-lite/assert",
        "test-assert-lite/assert/strict",
        "test-assert-lite/test",
        "node:assert",
        "node:assert/strict",
        "node:test",
    ],

    output: {
        file: "../browser/tests/bundled.mjs",
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
