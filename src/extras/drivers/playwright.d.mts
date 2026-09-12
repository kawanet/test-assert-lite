// Hand-written declarations for playwright.mjs, so cli.ts can call it
// with types while Playwright's own types stay out of this package.

export interface BrowserRunOptions {
    /** URL of the page to open, under the run's own path on the CLI's server. */
    page: string
    /** The verdict the page reports back to that server. */
    done: Promise<boolean>
    /** Which of Playwright's browsers to launch; chromium by default. */
    browser?: "chromium" | "firefox" | "webkit"
}

/**
 * Runs the suites in a headless browser and resolves to the verdict the
 * page sends back. Rejects when Playwright is missing or the browser is gone.
 */
export function runInPlaywright(options: BrowserRunOptions): Promise<boolean>
