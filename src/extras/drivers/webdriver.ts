// WebDriver adapter for the browser test CLI: the HTTP protocol that
// safaridriver, chromedriver and geckodriver speak, so a browser Playwright
// cannot launch, Safari on a Mac say, runs the suites too. Node's fetch()
// is all it takes, so no optional dependency is kept out of tsc here.

export interface WebDriverRunOptions {
    /** URL of the page to open, under the run's own path on the CLI's server. */
    page: string
    /** The verdict the page reports back to that server. */
    done: Promise<boolean>
    /** The WebDriver server, such as http://127.0.0.1:4444 */
    endpoint: string
    /** JSON sent as the body of POST /session; no capabilities by default. */
    session?: string
}

// A WebDriver response carries its payload, or its error, under `value`.
interface Reply {
    value: {sessionId?: string, error?: string, message?: string} & Record<string, unknown>
}

const call = async (endpoint: string, method: string, path: string, body?: string): Promise<Reply["value"]> => {
    const res = await fetch(endpoint + path, {method, headers: {"content-type": "application/json"}, body})
    const {value} = await res.json() as Reply
    if (!res.ok) throw new Error(`${method} ${path}: ${value.error}: ${value.message}`)
    return value
}

/**
 * Runs the suites on `page` in the browser the WebDriver
 * server at `endpoint` drives, and resolves to the verdict the page sends
 * back. The driver only opens the page: from there the page reports on its
 * own, so no command waits on the run and no script timeout is in play.
 */
export const runInWebDriver = async ({page, done, endpoint, session}: WebDriverRunOptions): Promise<boolean> => {
    let created: Reply["value"]
    try {
        created = await call(endpoint, "POST", "/session", session ?? JSON.stringify({capabilities: {}}))
    } catch (error) {
        // Nothing listening is the likely case, and the most useful hint.
        if (!(error instanceof TypeError)) throw error
        throw new Error(`No WebDriver server at ${endpoint}: \`safaridriver -p 4444\` or \`chromedriver --port=4444\``, {cause: error})
    }
    const base = `/session/${created.sessionId}`
    let failure: unknown
    try {
        await call(endpoint, "POST", `${base}/url`, JSON.stringify({url: page}))
        return await done
    } catch (error) {
        failure = error
        throw error
    } finally {
        // A session gone with its browser rejects this too: the error in
        // flight says why, so this one is reported beside it, not in its place.
        await call(endpoint, "DELETE", base).catch(error => {
            if (failure == null) throw error
            console.error(error)
        })
    }
}
