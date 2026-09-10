# Force bash so `set -o pipefail` works in the recipes below.
SHELL := bash
.SHELLFLAGS := -eo pipefail -c

# Sequential by design: the bundles take well under a second together, so
# -j buys nothing and only interleaves output. This also blocks a -j
# inherited through MAKEFLAGS.
.NOTPARALLEL:

# Tests live beside the sources, so the library inputs are the src/ tree
# with the test files filtered back out. Sources are nested, so this walks
# the tree. src/test-utils/ holds helpers only the suites use; src/extras/ and
# src/server/ are a separate build target below, so none counts as library input.
SRC := $(shell find ../src -name '*.ts' -not -name '*.test.ts' -not -path '*/test-utils/*' -not -path '*/extras/*' -not -path '*/server/*')
TEST_SRC := $(shell find ../src -name '*.test.ts') $(wildcard ../src/test-utils/*.ts)
EXTRAS_SRC := $(wildcard ../src/extras/*.ts) ../src/extras/playwright.mjs $(wildcard ../src/server/*.ts)
TYPES := $(wildcard ../types/*.d.ts)
BUILDER_SRC := $(wildcard ./*.ts)

MJS_DST := ../dist/test-assert-lite.mjs
MINJS_DST := ../dist/test-assert-lite.min.js
EXTRAS_DST := ../dist/test-assert-lite.extras.mjs
PKG_DST := ../dist/package.json
BROWSER_TEST_DST := ../browser/tests/bundled.mjs
BUILDER_TEST_DST := ./tests/bundled.mjs

MJS_CONFIG := ./rollup-mjs.config.ts
MINJS_CONFIG := ./rollup-minjs.config.ts
EXTRAS_CONFIG := ./rollup-extras.config.ts
BROWSER_TEST_CONFIG := ./rollup-browser-test.config.ts
BUILDER_TEST_CONFIG := ./rollup-builder-test.config.ts

# The shipped bundle is the whole library, so this cap is tight enough to
# notice an unintended dependency being pulled in. Pre-release, features
# still land in quick succession, so the headroom is wider than the ~20%
# over the actual size (round 10KB) it will settle on once published.
MJS_MAX_BYTES := 100000

# Minified build of the same sources, so the cap tracks the mjs one at the
# ratio the two currently show (about a third).
MINJS_MAX_BYTES := 35000

# The extras bundle externalizes the library, Node builtins and Playwright
# (see rollup-extras.config.ts) but carries the loopback server, the watch
# and the browser application, so the cap sits a third above what those come to.
EXTRAS_MAX_BYTES := 50000

# Shared by both test bundles, which inline the same suites while the
# package itself stays external. Development-only output, never published,
# so this only guards against gross growth and can stay generous.
TEST_MAX_BYTES := 300000

ALL := $(MJS_DST) $(MINJS_DST) $(EXTRAS_DST) $(BUILDER_TEST_DST)

# Build/test paths require Node's native TypeScript type-strip (default on
# Node 22.18+). Older runtimes report BUILDABLE=NO and skip the build.
BUILDABLE := $(shell node -e 'console.log(process.features.typescript ? "YES" : "NO")')

####

# Build all artifacts.
all: is-buildable $(ALL)

# Gate consumed by `all` and `npm prepack` so a build starts only where it
# can finish: with native type-strip and the devDependencies installed.
is-buildable:
	@ [ "$(BUILDABLE)" = "YES" ] && [ -f ../node_modules/.bin/rollup ]

# Inverse gate for `npm prepare`: a consumer install skips build/test and
# relies on prebuilt artifacts; contributors build on a capable runtime.
is-not-buildable:
	@ [ "$(BUILDABLE)" != "YES" ] || [ ! -f ../node_modules/.bin/rollup ]

# The published bundle. package.json points the package name at it, so the
# test bundle below resolves to this file rather than to the sources.
$(MJS_DST): $(MJS_CONFIG) $(SRC) $(BUILDER_SRC)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(MJS_MAX_BYTES) || { echo "ERROR: $@ exceeds $(MJS_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

# The extras (the CLI as a function), built alongside the library bundle
# they resolve at runtime through a plain relative import rather than
# package self-reference (see rollup-extras.config.ts for why). The
# executable bin/cli.mjs is hand-written and reaches this by subpath.
$(EXTRAS_DST): $(EXTRAS_CONFIG) $(EXTRAS_SRC) $(BUILDER_SRC) $(MJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(EXTRAS_MAX_BYTES) || { echo "ERROR: $@ exceeds $(EXTRAS_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

# The browser build. dist/package.json marks dist/ as CommonJS so Node can
# read the .min.js IIFE as a script despite the package being ESM.
$(MINJS_DST): $(MINJS_CONFIG) $(SRC) $(BUILDER_SRC) $(PKG_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(MINJS_MAX_BYTES) || { echo "ERROR: $@ exceeds $(MINJS_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

$(PKG_DST):
	@mkdir -p $(dir $@)
	echo '{"type":"commonjs"}' > $@
	@ls -l $@
	@echo ""

# Bundle of the test suites for the browser, with node:test, node:assert
# and the package name left external for the import map the CLI serves,
# which points all three at the IIFE build through its ES module shim.
$(BROWSER_TEST_DST): $(BROWSER_TEST_CONFIG) $(SRC) $(BUILDER_SRC) $(TEST_SRC) $(TYPES) $(MJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@# An inlined copy of the library would be a second harness beside the
	@# one the import map serves, so the suites must reach it through the
	@# alias only.
	@! grep -q 'const createTAL' $@ || { echo "ERROR: $@ inlines the library" >&2; exit 1; }
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(TEST_MAX_BYTES) || { echo "ERROR: $@ exceeds $(TEST_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

# Bundle of the test suites with node:test and node:assert left as
# written: the CLI's resolve hook points both at this package, so the
# suites exercise the library with the library.
$(BUILDER_TEST_DST): $(BUILDER_TEST_CONFIG) $(SRC) $(BUILDER_SRC) $(TEST_SRC) $(TYPES) $(MJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@# An alias that misses a relative import inlines the sources instead,
	@# and the suites then test a second copy of the library.
	@! grep -q 'const createTAL' $@ || { echo "ERROR: $@ inlines the library" >&2; exit 1; }
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(TEST_MAX_BYTES) || { echo "ERROR: $@ exceeds $(TEST_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

####

# Consumer `npm install` skips the heavy test-full step to keep install fast.
test:
	@case "$$npm_command" in \
		install|ci|pack) echo "npm $$npm_command detected: skipping full tests." ;; \
		*) $(MAKE) test-full ;; \
	esac

# The suites run twice: once under node:test, then again under the library
# itself, so a regression in the runner cannot hide behind the real one.
# The second run goes through the CLI: the bundle only registers tests as
# a side effect and never calls run() itself.
test-full: test-quick
	cd .. && node --test 'src/**/*.test.ts'
	cd .. && ./bin/cli.mjs $(BUILDER_TEST_DST:./%=builder/%)

test-quick: all
	cd .. && node_modules/.bin/tsc --noEmit
	cd .. && node_modules/.bin/ts-refine format --check
	cd .. && node_modules/.bin/ts-refine imports --check

# The suites that wait on real time rather than a timer test-full skips,
# such as the reporter's ten-second heartbeat: run by hand or before a
# release, since they would slow every run and flake where short waits
# cannot be trusted. TAL_SLOW_TESTS=1 is what tells them to run at all.
test-slow:
	cd .. && TAL_SLOW_TESTS=1 node --test 'src/**/*.test.ts'

####

clean:
	/bin/rm -fr $(ALL) $(BROWSER_TEST_DST) $(PKG_DST)

.PHONY: all clean test test-full test-slow is-buildable is-not-buildable
