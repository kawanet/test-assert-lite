# Force bash so `set -o pipefail` works in the recipes below.
SHELL := bash
.SHELLFLAGS := -eo pipefail -c

# Tests live beside the sources, so the library inputs are the src/ tree
# with the test files filtered back out. Sources are nested, so this walks
# the tree. src/test-utils/ holds helpers only the suites use, so it counts
# as test input rather than library input.
SRC := $(shell find ../src -name '*.ts' -not -name '*.test.ts' -not -path '*/test-utils/*')
TEST_SRC := $(shell find ../src -name '*.test.ts') $(wildcard ../src/test-utils/*.ts)
TYPES := $(wildcard ../types/*.d.ts)
BUILDER_SRC := $(wildcard ./*.ts)
BROWSER_SRC := $(wildcard ../browser/*.js)

MJS_DST := ../dist/test-assert-lite.mjs
MINJS_DST := ../dist/test-assert-lite.min.js
PKG_DST := ../dist/package.json
BROWSER_TEST_DST := ../browser/tests/bundled.js
BUILDER_TEST_DST := ./tests/bundled.mjs

# The subpath entries come out of one rollup run. The first file stands for
# the run as the make target; the full list is for clean.
EXPORTS_SRC := $(wildcard ../src/exports/*.ts)
EXPORTS_DST := ../dist/test.mjs
EXPORTS_ALL := $(foreach name,test assert assert-strict,../dist/$(name).mjs ../dist/$(name).cjs)

MJS_CONFIG := ./rollup-mjs.config.ts
MINJS_CONFIG := ./rollup-minjs.config.ts
EXPORTS_CONFIG := ./rollup-exports.config.ts
BROWSER_TEST_CONFIG := ./rollup-browser-test.config.ts
BUILDER_TEST_CONFIG := ./rollup-builder-test.config.ts

# The shipped bundle is the whole library, so this cap is tight enough to
# notice an unintended dependency being pulled in.
MJS_MAX_BYTES := 40000

# Minified build of the same sources, so the cap tracks the mjs one.
MINJS_MAX_BYTES := 20000

# Shared by both test bundles, which inline the same suites while the
# package itself stays external. The browser one also inlines
# browser/import.js and is wrapped as an IIFE, so it sets the ceiling.
# This only guards against gross growth.
TEST_MAX_BYTES := 120000

ALL := $(MJS_DST) $(MINJS_DST) $(EXPORTS_DST) $(BUILDER_TEST_DST)

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

# Subpath entries `test-assert-lite/test`, `/assert` and `/assert/strict`:
# re-exports from the two bundles above, as ESM and as CommonJS glue.
$(EXPORTS_DST): $(EXPORTS_CONFIG) $(EXPORTS_SRC) $(BUILDER_SRC) $(MJS_DST) $(MINJS_DST)
	../node_modules/.bin/rollup -c $<
	@ls -l $(EXPORTS_ALL)
	@echo ""

# Bundle of the test suites for browser/tests.html, with node:test and
# node:assert pointed at the global from the .min.js build.
$(BROWSER_TEST_DST): $(BROWSER_TEST_CONFIG) $(SRC) $(BUILDER_SRC) $(TEST_SRC) $(TYPES) $(BROWSER_SRC) $(MINJS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@ls -l $@
	@test "$$(wc -c < $@)" -le $(TEST_MAX_BYTES) || { echo "ERROR: $@ exceeds $(TEST_MAX_BYTES) byte cap" >&2; exit 1; }
	@echo ""

# Bundle of the test suites with node:test and node:assert aliased to this
# package, so the suites exercise the library with the library.
$(BUILDER_TEST_DST): $(BUILDER_TEST_CONFIG) $(SRC) $(BUILDER_SRC) $(TEST_SRC) $(TYPES) $(MJS_DST) $(EXPORTS_DST)
	@mkdir -p $(dir $@)
	../node_modules/.bin/rollup -c $<
	@# Externalizing by regular expression would leave the suites bound to
	@# the real runner without any warning, so check the alias took effect.
	@grep -q 'from .test-assert-lite/test.' $@ || { echo "ERROR: $@ still imports node:test" >&2; exit 1; }
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
test-full: all
	cd .. && node_modules/.bin/tsc --noEmit
	cd .. && node_modules/.bin/ts-refine format --check && node_modules/.bin/ts-refine imports --check
	cd .. && node --test 'src/**/*.test.ts'
	cd .. && node $(BUILDER_TEST_DST:./%=builder/%)

####

clean:
	/bin/rm -fr $(ALL) $(EXPORTS_ALL) $(BROWSER_TEST_DST) $(PKG_DST)

.PHONY: all clean test test-full is-buildable is-not-buildable
