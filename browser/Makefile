# Force bash so `set -o pipefail` works in the recipes below.
SHELL := bash
.SHELLFLAGS := -eo pipefail -c

# Sequential by design: nothing here gains from -j, and `test` leans on
# install running before the build. This also blocks a -j inherited
# through MAKEFLAGS.
.NOTPARALLEL:

MJS_DST := ../packages/test-assert-lite/dist/test-assert-lite.js
MINJS_DST := ../packages/test-assert-lite/dist/test-assert-lite.min.js
EXTRAS_DST := ../packages/test-assert-cli/dist/test-assert-cli.js
BROWSER_TEST_DST := ../browser/tests/bundled.mjs

# The executables fixed on one browser each, run from the checkout.
CHROMIUM := node packages/playwright-js-cli/bin/chromium.js
FIREFOX := node packages/playwright-js-cli/bin/firefox.js
WEBKIT := node packages/playwright-js-cli/bin/webkit.js
WEBDRIVER := node packages/webdriver-js-cli/bin/webdriver.js

# The bundle rule, its size check, and its dependencies belong to the
# repository-wide builder Makefile. This entry point is for browser CI.
all: bundled

# Build tools come from the package's own npm install; `serve` must not
# pull a browser in, so the bundle does not depend on install-chromium.
bundled:
	$(MAKE) -C ../builder $(MJS_DST) $(MINJS_DST) $(EXTRAS_DST) $(BROWSER_TEST_DST)

# playwright itself comes with playwright-js-cli, as a dependency, so npm
# install brings it along with the build tools. The browsers do not.
install: install-chromium

# --with-deps re-runs apt-get (with sudo) even when nothing is missing. A
# launch that succeeds is exactly what `test` needs, so probe that and skip
# the flag; any failure (no binary, missing libs, fresh runner) keeps it.
# Deferred (=): only evaluated when this recipe actually runs.
LAUNCHABLE = $(shell cd .. && node -e 'require("playwright").chromium.launch().then(b=>b.close()).catch(()=>process.exit(1))' 2>/dev/null && echo YES)

install-chromium:
	cd .. && npx --no-install playwright install --only-shell chromium$(if $(LAUNCHABLE),, --with-deps)

# All three browsers, for a deliberate full run rather than every `test`:
# no launch probe, the apt-get step is accepted as part of its cost.
install-all:
	cd .. && npx --no-install playwright install --only-shell chromium firefox webkit --with-deps

# Each run builds what it tests; a plain `make test-webkit` works on its own.
test-chromium: all
	cd .. && $(CHROMIUM) browser/tests/bundled.mjs

test-firefox: all
	cd .. && $(FIREFOX) browser/tests/bundled.mjs

test-webkit: all
	cd .. && $(WEBKIT) browser/tests/bundled.mjs

# Off CI, the driver being started by hand; each WEBDRIVER_* set here goes
# to the CLI option of the same name. safaridriver on a Mac, then chromedriver:
#   WEBDRIVER_HOST=192.168.0.2 make test-webdriver
#   WEBDRIVER_ENDPOINT=http://127.0.0.1:9515 WEBDRIVER_CONFIG=../packages/webdriver-js-cli/webdriver-config/chrome-headless.json make test-webdriver
test-webdriver: all
	cd .. && $(WEBDRIVER) \
		$(if $(WEBDRIVER_ENDPOINT),--endpoint $(WEBDRIVER_ENDPOINT)) \
		$(if $(WEBDRIVER_CONFIG),--webdriver-config $(abspath $(WEBDRIVER_CONFIG))) \
		$(if $(WEBDRIVER_HOST),--port $(WEBDRIVER_HOST):0) \
		browser/tests/bundled.mjs

test: test-chromium

# Every Playwright browser, on the same bundle. Run by `npm run test-max`.
test-playwright: install-all test-chromium test-firefox test-webkit

# The same bundle for a person: prints the URL and serves until Ctrl-C.
serve: all
	cd .. && node packages/test-assert-cli/bin/tacli.js --serve --alias index.js=browser/tests/bundled.mjs

# Browser bundle cleanup remains owned by builder/Makefile.
clean:
	@: # NOP

.PHONY: all bundled install install-chromium install-all test test-chromium test-firefox test-webkit test-playwright test-webdriver serve clean
