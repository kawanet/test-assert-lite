# Force bash so `set -o pipefail` works in the recipes below.
SHELL := bash
.SHELLFLAGS := -eo pipefail -c

# Sequential by design: nothing here gains from -j, and `test` leans on
# install running before the build. This also blocks a -j inherited
# through MAKEFLAGS.
.NOTPARALLEL:

PLAYWRIGHT_VERSION := 1.62.1

MJS_DST := ../esm/test-assert-lite.mjs
MINJS_DST := ../dist/test-assert-lite.min.js
EXTRAS_DST := ../esm/test-assert-lite.extras.mjs
BROWSER_TEST_DST := ../browser/tests/bundled.mjs

# The bundle rule, its size check, and its dependencies belong to the
# repository-wide builder Makefile. This entry point is for browser CI.
all: bundled

# Build tools come from the package's own npm install; `serve` must not
# pull Playwright in, so the bundle does not depend on install-playwright.
bundled:
	$(MAKE) -C ../builder $(MJS_DST) $(MINJS_DST) $(EXTRAS_DST) $(BROWSER_TEST_DST)

# Keep Playwright out of package.json. CI installs it transiently alongside
# the project's build dependencies, then downloads only the headless shell.
install: install-chromium

# npm's own up-to-date check is the slow part of a repeat run. Comparing the
# installed version is near-free and also catches a PLAYWRIGHT_VERSION bump.
PLAYWRIGHT_INSTALLED = $(shell cd .. && node -p 'require("playwright/package.json").version' 2>/dev/null)

install-playwright:
	[ "$(PLAYWRIGHT_INSTALLED)" = "$(PLAYWRIGHT_VERSION)" ] || \
	( cd .. && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright@$(PLAYWRIGHT_VERSION) --no-save --ignore-scripts --no-audit --no-fund )

# --with-deps re-runs apt-get (with sudo) even when nothing is missing. A
# launch that succeeds is exactly what `test` needs, so probe that and skip
# the flag; any failure (no binary, missing libs, fresh runner) keeps it.
# Deferred (=): only evaluated when this recipe actually runs.
LAUNCHABLE = $(shell cd .. && node -e 'require("playwright").chromium.launch().then(b=>b.close()).catch(()=>process.exit(1))' 2>/dev/null && echo YES)

install-chromium: install-playwright
	cd .. && npx --no-install playwright install --only-shell chromium$(if $(LAUNCHABLE),, --with-deps)

# All three browsers, for a deliberate full run rather than every `test`:
# no launch probe, the apt-get step is accepted as part of its cost.
install-all: install-playwright
	cd .. && npx --no-install playwright install --only-shell chromium firefox webkit --with-deps

# Each run builds what it tests; a plain `make test-webkit` works on its own.
test-chromium: all
	cd .. && node bin/cli.mjs --playwright chromium browser/tests/bundled.mjs

test-firefox: all
	cd .. && node bin/cli.mjs --playwright firefox browser/tests/bundled.mjs

test-webkit: all
	cd .. && node bin/cli.mjs --playwright webkit browser/tests/bundled.mjs

# Off CI, the driver being started by hand; each WEBDRIVER_* set here goes
# to the CLI option of the same name. safaridriver on a Mac, then chromedriver:
#   WEBDRIVER_HOST=192.168.0.2 make test-webdriver
#   WEBDRIVER_ENDPOINT=http://127.0.0.1:9515 WEBDRIVER_SESSION=session/chrome-headless.json make test-webdriver
test-webdriver: all
	cd .. && node bin/cli.mjs --webdriver \
		$(if $(WEBDRIVER_ENDPOINT),--endpoint $(WEBDRIVER_ENDPOINT)) \
		$(if $(WEBDRIVER_SESSION),--webdriver-session $(abspath $(WEBDRIVER_SESSION))) \
		$(if $(WEBDRIVER_HOST),--host $(WEBDRIVER_HOST)) \
		browser/tests/bundled.mjs

# `install` first: its npm step also brings the build tools, so a plain
# `make -C browser test` works from a clean checkout. It is cheap once
# Playwright and the browser are present (see LAUNCHABLE).
test: install test-chromium

# Every Playwright browser, on the same bundle. Run by `npm run test-max`.
test-playwright: install-all test-chromium test-firefox test-webkit

# The same bundle for a person: prints the URL and serves until Ctrl-C.
serve: all
	cd .. && node bin/cli.mjs --serve browser/tests/bundled.mjs

# Browser bundle cleanup remains owned by builder/Makefile.
clean:
	@: # NOP

.PHONY: all bundled install install-playwright install-chromium install-all test test-chromium test-firefox test-webkit test-playwright test-webdriver serve clean
