/**
 * https://github.com/kawanet/test-assert-lite
 *
 * A subset of `node:test` and `node:assert` that runs in browsers.
 */

export {} // external module indicator

export declare namespace TAL {
    // --- test ---

    type TestFn = (t: TestContext) => void | Promise<void>

    type SuiteFn = (s: SuiteContext) => void | Promise<void>

    type HookFn = () => void | Promise<void>

    // The test entry, `test-assert-lite/test`: what declares suites, tests and hooks.
    interface RegistrarAPI {
        after(fn: HookFn): void

        before(fn: HookFn): void

        describe: SuiteAPI
        it: TestAPI
        suite: SuiteAPI
        test: TestAPI
    }

    interface TestOptions {
        skip?: boolean | string
        // A todo runs and is reported, but is counted as todo whatever the
        // verdict, and its failure does not fail the run. A skip outranks it.
        todo?: boolean | string
        timeout?: number
    }

    interface SuiteContext {
        readonly name: string
    }

    interface TestContext {
        readonly name: string
        readonly assert: TestContextAssert
        skip(message?: string): void
        todo(message?: string): void
        diagnostic(message: string): void

        // Subtests run immediately, ahead of the parent's remaining body.
        // Unlike the top-level `it`, the returned promise is meaningful.
        // One declared after the parent was reported (after its timeout,
        // say) runs at the top level and fails as parentAlreadyFinished.
        test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>
        test(name?: string, fn?: TestFn): Promise<void>
        test(options?: TestOptions, fn?: TestFn): Promise<void>
        test(fn?: TestFn): Promise<void>
    }

    // `describe` / `suite`. The static variants take the same arguments.
    interface SuiteBase {
        (name?: string, options?: TestOptions, fn?: SuiteFn): void
        (name?: string, fn?: SuiteFn): void
        (options?: TestOptions, fn?: SuiteFn): void
        (fn?: SuiteFn): void
    }

    interface SuiteAPI extends SuiteBase {
        skip: SuiteBase
        todo: SuiteBase
    }

    // `it` / `test`. The static variants take the same arguments.
    interface TestBase {
        (name?: string, options?: TestOptions, fn?: TestFn): void
        (name?: string, fn?: TestFn): void
        (options?: TestOptions, fn?: TestFn): void
        (fn?: TestFn): void
    }

    interface TestAPI extends TestBase {
        skip: TestBase
        todo: TestBase
    }

    // --- assert ---

    // What `doesNotThrow` filters by: a RegExp tested against String(error),
    // a class the error must be an instance of (Error or not, as node:assert
    // takes any), or a validation function that returns true on a match.
    type ErrorFilter = RegExp | (new (...args: never[]) => object) | ((thrown: unknown) => boolean)

    // What `throws` matches against: any filter above, or an object whose
    // properties the error must carry, a RegExp value being tested against
    // the property's string form. An Error instance counts as such an
    // object, name and message included. The same shapes node:assert takes.
    type AssertPredicate = ErrorFilter | object

    interface AssertBase {
        fail(message?: string | Error): never
        equal(actual: unknown, expected: unknown, message?: string | Error): void
        notEqual(actual: unknown, expected: unknown, message?: string | Error): void
        deepEqual(actual: unknown, expected: unknown, message?: string | Error): void
        notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void
        strictEqual(actual: unknown, expected: unknown, message?: string | Error): void
        notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void
        deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void
        notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void
        // As in node:assert, a string in the second position is the message.
        throws(block: () => unknown, message?: string): void
        throws(block: () => unknown, expected: AssertPredicate | undefined, message?: string | Error): void
        doesNotThrow(block: () => unknown, message?: string): void
        doesNotThrow(block: () => unknown, expected: ErrorFilter | undefined, message?: string | Error): void
        // The same pair for a promise, or an async function returning one:
        // judged once it settles, and a misuse rejects rather than throws.
        // Declared as node:assert declares them.
        rejects(block: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>
        rejects(block: Promise<unknown> | (() => Promise<unknown>), expected: AssertPredicate | undefined, message?: string | Error): Promise<void>
        doesNotReject(block: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>
        doesNotReject(block: Promise<unknown> | (() => Promise<unknown>), expected: ErrorFilter | undefined, message?: string | Error): Promise<void>
        match(value: string, regExp: RegExp, message?: string | Error): void
        doesNotMatch(value: string, regExp: RegExp, message?: string | Error): void
    }

    // Reachable as `t.assert`. `ok` and `ifError` are plain checks here rather
    // than assertion signatures: narrowing through a callback parameter trips
    // TS2775, which `node:test` itself hits on `t.assert.ok()`.
    interface TestContextAssert extends AssertBase {
        ok(value: unknown, message?: string | Error): void
        ifError(value: unknown): void
    }

    // `assert` compares loosely in equal / notEqual / deepEqual /
    // notDeepEqual, `strict` (reachable as `assert.strict` too) strictly;
    // the *StrictEqual names are strict on both, as in node:assert.
    interface Assert extends AssertBase {
        (value: unknown, message?: string | Error): asserts value
        ok(value: unknown, message?: string | Error): asserts value
        ifError(value: unknown): asserts value is null | undefined
        strict: Assert
    }

    // --- failures ---

    type FailureType =
        | "testCodeFailure"
        | "hookFailed"
        | "cancelledByParent"
        | "testTimeoutFailure"
        | "subtestsFailed"
        | "parentAlreadyFinished"

    // A failure the runner produced itself, or a thrown value that was not
    // an Error. An Error thrown by test code is reported as is. `code`
    // matches node:test's wrapper so a check written for it holds here.
    interface TesterError extends Error {
        readonly name: "TesterError"
        readonly code: "ERR_TEST_FAILURE"
        readonly failureType: FailureType
        readonly cause: unknown
    }

    // --- events ---

    interface TestStart {
        name: string
        nesting: number
    }

    // A suite is reported after its children, with `type: "suite"`.
    // `testNumber` counts within the parent, suites and tests together.
    // A result carries `skip` or `todo`, never both: a skip outranks a todo.
    interface TestPass {
        name: string
        nesting: number
        testNumber: number
        skip?: string | boolean
        todo?: string | boolean
        details: {
            duration_ms: number
            type: "suite" | "test"
        }
    }

    // `error` is what the test threw, or a TesterError. A suite fails
    // with its hook's or body's error, or with `subtestsFailed` when only
    // a child did. A test never run because its parent failed is reported
    // as `cancelledByParent` and counted under `cancelled`.
    interface TestFail {
        name: string
        nesting: number
        testNumber: number
        skip?: string | boolean
        todo?: string | boolean
        details: {
            duration_ms: number
            type: "suite" | "test"
            error: Error
        }
    }

    interface TestDiagnostic {
        message: string
        nesting: number
        level: "info" | "warn" | "error"
    }

    // What node --test relays from a test file's own streams. This
    // package's runner emits neither.
    interface TestStdout {
        file: string
        message: string
    }

    interface TestStderr {
        file: string
        message: string
    }

    interface TestSummary {
        counts: {
            cancelled: number
            failed: number
            passed: number
            skipped: number
            suites: number
            tests: number
            todo: number
        }
        duration_ms: number
        success: boolean
    }

    type TestEvent =
        | {type: "test:start"; data: TestStart}
        | {type: "test:pass"; data: TestPass}
        | {type: "test:fail"; data: TestFail}
        | {type: "test:diagnostic"; data: TestDiagnostic}
        | {type: "test:stdout"; data: TestStdout}
        | {type: "test:stderr"; data: TestStderr}
        | {type: "test:summary"; data: TestSummary}

    // --- reporter ---

    type ReporterFn = (source: AsyncIterable<TestEvent>) => AsyncIterable<string>

    type OutputFn = (text: string) => void | Promise<void>

    interface SpecOptions {
        // Defaults on for a Node TTY unless NO_COLOR or NODE_DISABLE_COLORS is set; off otherwise.
        colors?: boolean
        /** Reduces output while keeping failures visible. */
        quiet?: boolean
    }

    // The reporters the package ships
    interface Reporter {
        spec(options?: SpecOptions): ReporterFn
        tap(): ReporterFn
        html(): ReporterFn
    }

    // --- session ---

    // A window, or what stands in for one: its `error` and `unhandledrejection` events.
    interface EventTargetLike {
        addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
        removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
    }

    // Node's process, or what stands in for it: its `uncaughtException` and `unhandledRejection` events.
    interface EventEmitterLike {
        on(event: string, listener: (...args: unknown[]) => void): unknown
        off(event: string, listener: (...args: unknown[]) => void): unknown
    }

    // What the bridge posts with, by a path relative to the page. The
    // response is never read.
    type FetchLike = (url: string, init: {method: "POST", body: string}) => Promise<unknown>

    // What a session takes over: the five methods a page's console has.
    interface ConsoleLike {
        debug(...args: unknown[]): void
        log(...args: unknown[]): void
        info(...args: unknown[]): void
        warn(...args: unknown[]): void
        error(...args: unknown[]): void
    }

    interface SessionOptions {
        /** What the run's events are formatted with; `reporter.spec()` unless given. */
        reporter?: ReporterFn | string
        /** Where the formatted text goes, the run's stdout unless given. */
        output?: OutputFn
        /** Reports the run to the CLI over this bridge. Nothing is sent without one. */
        bridge?: BridgeAPI
        /**
         * Takes the errors outside the tests, until end(): the uncaught
         * exceptions and unhandled rejections of the window or the process
         * given, each one failed test at the top level.
         */
        uncaught?: EventTargetLike | EventEmitterLike
        /**
         * A console the session takes over until end(): debug, log and info
         * go to `stdout`, warn and error to `stderr`, each call one line.
         */
        console?: ConsoleLike
        /** Reduces output while keeping failures visible. The summary event is unchanged. */
        quiet?: boolean
    }

    // What end() resolves with: whether every test passed.
    interface SessionResult {
        success: boolean
    }

    // One of the run's streams.
    interface Writer {
        write(chunk: string): void
    }

    // The session's own entry, `test-assert-lite/session`: opening it,
    // loading the suites into it, ending it, and reaching the CLI.
    interface SessionAPI {
        /** Opens a new session for the following tests. */
        session(options?: SessionOptions): void
        /** Imports a suite, by URL or absolute path, so its tests are declared. */
        load(file: string): Promise<void>
        /** Runs every registered test, and closes the session. */
        end(): Promise<SessionResult>
        /** Makes the bridge to the CLI over the fetch given, for session() to report with. */
        connect: (options: {fetch: FetchLike}) => BridgeAPI
    }

    // --- session bridge ---

    // The page's side of a CLI run, shaped after a child process: its
    // streams, and a channel for messages.
    interface BridgeAPI {
        /** The CLI's stdout and stderr, as the page writes them. */
        stdout: Writer
        stderr: Writer
        /** Sends a message to the CLI, as a child process does to its parent. */
        send: (message: SessionEvent, callback?: (error: Error | null) => void) => void
    }

    // What send() carries.
    type SessionEvent =
        | {type: "session:begin", data?: undefined}
        | {type: "session:end", data: SessionResult}

    // The paths under the run's URL that the bridge posts to.
    type BridgeChannel = "stdout" | "stderr" | "send"

    // --- harness ---

    // One isolated set of everything the package offers: the tests, the
    // assertions, the reporters and the session that reports them.
    interface TestHarness {
        assert: Assert
        reporter: Reporter
        session: SessionAPI
        test: RegistrarAPI
    }
}

/** The shared harness behind the subpaths: `test-assert-lite/test`, `/assert`, `/session` and the reporters. */
export declare const sharedTAL: TAL.TestHarness

/** Creates a local harness apart from `sharedTAL`. */
export declare function createTAL(): TAL.TestHarness
