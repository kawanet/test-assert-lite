# Force bash so `set -o pipefail` works in the recipes below.
SHELL := bash
.SHELLFLAGS := -eo pipefail -c

# Sequential by design: the bundles take well under a second together, so
# -j buys nothing and only interleaves output. This also blocks a -j
# inherited through MAKEFLAGS.
.NOTPARALLEL:

# Tests live beside the sources, so the library inputs are the src/ tree
# with the test files filtered back out. Sources are nested, so this walks
# the tree. src/test-utils/ holds helpers only the suites use; src/extras/ is
# a separate build target below, so none counts as library input.
SRC := $(shell find ../src -name '*.ts' -not -name '*.test.ts' -not -path '*/test-utils/*' -not -path '*/extras/*')
TEST_SRC := $(shell find ../src -name '*.test.ts') $(wildcard ../src/test-utils/*.ts)
EXTRAS_SRC := $(shell find ../src/extras -name '*.ts' -or -name '*.mjs' -or -name '*.js')
TYPES := $(wildcard ../packages/*/types/*.d.ts)
BUILDER_SRC := $(wildcard ./*.ts)

MJS_DST := ../packages/test-assert-lite/dist/test-assert-lite.js
MINJS_DST := ../packages/test-assert-lite/dist/test-assert-lite.min.js
EXTRAS_DST := ../packages/test-assert-cli/dist/test-assert-cli.js
BROWSER_TEST_DST := ../browser/tests/bundled.mjs
BUILDER_TEST_DST := ./tests/bundled.mjs

MJS_CONFIG := ./rollup-mjs.config.ts
MINJS_CONFIG := ./rollup-minjs.config.ts
EXTRAS_CONFIG := ./rollup-extras.config.ts
BROWSER_TEST_CONFIG := ./rollup-browser-test.config.ts
BUILDER_TEST_CONFIG := ./rollup-builder-test.config.ts

MJS_MAX_BYTES := 100000
MINJS_MAX_BYTES := $(shell expr 1024 \* 32)
EXTRAS_MAX_BYTES := 80000
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

# The CLI as a function imports the library by its package name, which
# resolves to the workspace sibling. The executable bin/tacli.js is
# hand-written and reaches this by the CLI package's name.
$(EXTRAS_DST): $(EXTRAS_CONFIG) $(EXTRAS_SRC) $(BUILDER_SRC) $(MJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(EXTRAS_MAX_BYTES) || { echo "ERROR: $@ exceeds $(EXTRAS_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

# The browser build: the library as one minified ES module.
$(MINJS_DST): $(MINJS_CONFIG) $(SRC) $(BUILDER_SRC)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(MINJS_MAX_BYTES) || { echo "ERROR: $@ exceeds $(MINJS_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

$(BROWSER_TEST_DST): $(BROWSER_TEST_CONFIG) $(SRC) $(BUILDER_SRC) $(TEST_SRC) $(TYPES) $(MJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@! grep -q 'const createTAL' $@ || { echo "ERROR: $@ inlines the library" >&2; exit 1; }
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(TEST_MAX_BYTES) || { echo "ERROR: $@ exceeds $(TEST_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

$(BUILDER_TEST_DST): $(BUILDER_TEST_CONFIG) $(SRC) $(BUILDER_SRC) $(TEST_SRC) $(TYPES) $(MJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
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
	cd .. && ./packages/test-assert-cli/bin/tacli.js $(BUILDER_TEST_DST:./%=builder/%)

test-quick: all
	cd .. && node_modules/.bin/tsc --noEmit
	cd .. && node_modules/.bin/ts-refine format --check
	cd .. && node_modules/.bin/ts-refine imports --check

####

clean:
	/bin/rm -fr $(ALL) $(BROWSER_TEST_DST)

.PHONY: all clean test test-full is-buildable is-not-buildable
