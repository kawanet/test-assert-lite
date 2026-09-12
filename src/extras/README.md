# src/extras/

Tests in this directory are left out of `tests/bundled.mjs`, so they never
run against the built package: import each file here directly, by relative
path. Only the suites the bundle carries have to reach the library through
`src/index.ts`, the one specifier rewritten to the package.
