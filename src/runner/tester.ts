import type * as declared from "test-assert-lite"
import type {ReporterControl} from "../reporter.ts"
import {TesterError, cancelledByParent, parentAlreadyFinished, testRunnerError} from "../utils/tester-error.ts"
import type {Args} from "./declare.ts"
import {nameOf, normalize, skipOf, todoOf} from "./declare.ts"
import type {HarnessState} from "./suite.ts"

type TestOptions = declared.TAL.TestOptions
type TestFn = declared.TAL.TestFn
type SuiteFn = declared.TAL.SuiteFn
type HookFn = declared.TAL.HookFn
type Counters = declared.TAL.TestSummary["counts"]

type Kind = "suite" | "test"

// How a test or suite ended, as its parent sees it. A parent whose child
// failed or was cancelled fails in turn, as it does in node:test.
export type Outcome = "passed" | "failed" | "cancelled" | "skipped"

// What a parent that gave up hands to a child: the error to report and
// how to count it.
interface Verdict {
    error: Error
    outcome: Outcome
}

// What one run() shares with every test in it.
export interface Run {
    counters: Counters
    success: boolean
    emit: ReporterControl["emit"]
    // t.assert uses the harness's assert, so once it takes options, what a
    // body sees stays consistent within one run().
    assert: declared.TAL.AssertMethods
    harness: HarnessState
    // Set once the root has nothing left to run. A body that outlived its
    // verdict is not waited for; what it does after this is dropped.
    closed: boolean
}

const timeoutAfter = (ms: number): {promise: Promise<never>, error: TesterError, cancel: () => void} => {
    let timer: ReturnType<typeof setTimeout>
    const error = new TesterError(`test timed out after ${ms}ms`, "testTimeoutFailure")
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error), ms)
    })
    return {promise, error, cancel: () => clearTimeout(timer)}
}

// One test, suite or the root, from its declaration to its report. The
// parent declares it, then starts it in turn; the test decides its own
// verdict and reports itself, unless the parent gave up first, in which
// case the parent's verdict is handed down and reported for it.
export class Test {
    readonly kind: Kind
    readonly name: string
    readonly options: TestOptions
    readonly fn: TestFn | SuiteFn | undefined
    readonly parent: Test | null
    readonly nesting: number
    readonly testNumber: number
    readonly before: HookFn[] = []
    readonly after: HookFn[] = []
    readonly children: Test[] = []

    // The failure a late subtest carries from the start: node:test files it
    // as parentAlreadyFinished whatever its body does.
    late: TesterError | undefined
    // Resumes the body that declared this late subtest, once it is reported.
    private onDone: (() => void) | undefined

    private run!: Run
    private announced = false
    private started = false
    private startedAt = 0
    private endedAt = 0
    // The verdict is out, from this test or from a parent that gave up on
    // it. Set before the first reporter await, so nothing the body does
    // while the verdict is being reported can reopen it.
    private settled = false
    private reported = false
    private error: Error | undefined
    private cancelled = false
    // A skip called from the body outranks the one it was declared with.
    private skipped: string | true | undefined
    // Declared, called from the body, or inherited: a todo's subtests are
    // todo as well, as in node:test, though only as a bare mark.
    private todo: string | true | undefined
    // The verdict a parent handed down, when it gave up on this test.
    private closedWith: Verdict | undefined

    // node:test runs subtests one at a time: a new one waits for the
    // previous one, awaited or not, while the first starts synchronously.
    private last: Promise<unknown> = Promise.resolve()
    private active = 0
    private pending: Promise<Outcome>[] = []
    // Resolves once this subtest has reported, for a parent that settles
    // while the subtest, already settled itself, is still reporting.
    private finish: Promise<unknown> | undefined

    constructor(kind: Kind, name: string, options: TestOptions, fn: TestFn | SuiteFn | undefined, parent: Test | null) {
        this.kind = kind
        this.name = name
        this.options = options
        this.fn = fn
        this.parent = parent
        this.nesting = parent == null ? -1 : parent.nesting + 1
        this.testNumber = parent == null ? 0 : parent.children.length + 1
        this.todo = todoOf(options) ?? (parent?.todo != null ? true : undefined)
    }

    get isRoot(): boolean {
        return this.parent == null
    }

    // Declares a child in the next slot. A child of a settled parent is
    // closed on the spot, with the parent's verdict handed down.
    declare(kind: Kind, name: string, options: TestOptions, fn: TestFn | SuiteFn | undefined): Test {
        const child = new Test(kind, name, options, fn, this)
        // A child of a running parent may be reported before it starts.
        if (this.run != null) child.run = this.run
        this.children.push(child)
        const verdict = this.verdictForChildren
        if (verdict != null) child.close(verdict)
        return child
    }

    // What this test hands to a child it gives up on. The root has no
    // result of its own, so node:test charges its hook error to each direct
    // child; anywhere else the child is cancelled.
    private get verdictForChildren(): Verdict | undefined {
        if (!this.settled) return undefined
        if (this.isRoot) return this.error == null ? undefined : {error: this.error, outcome: "failed"}
        return {error: cancelledByParent(), outcome: "cancelled"}
    }

    // Takes the verdict a parent handed down. Whatever this test declares
    // from now on is closed on declaration, since it is settled.
    private close(verdict: Verdict): void {
        if (this.settled) return
        this.settled = true
        this.endedAt = performance.now()
        this.closedWith = verdict
        this.error = verdict.error
        this.cancelled = verdict.outcome === "cancelled"
    }

    private get skip(): string | true | undefined {
        return this.skipped ?? skipOf(this.options)
    }

    // ---- what t gives a body ----

    private context(): declared.TAL.TestContext {
        return {
            name: this.name,
            assert: this.run.assert,
            skip: (message) => {
                // As in node:test the body is not interrupted; only the
                // verdict changes, and one already out stays as it is.
                if (this.settled) return
                this.skipped = message ?? true
            },
            todo: (message) => {
                if (this.settled) return
                this.todo = message ?? true
            },
            diagnostic: (message) => {
                // node:test keeps diagnostics for the report; one arriving
                // after the report has no place to go.
                if (this.settled) return
                void this.run.emit("test:diagnostic", {message, nesting: this.nesting, level: "info"})
            },
            test: (...args: Args<TestFn>) => this.subtest(args),
        }
    }

    private subtest(args: Args<TestFn>): Promise<void> {
        const {name, options, fn} = normalize<TestFn>(args)
        if (this.settled) return this.lateSubtest(nameOf(name, fn), options, fn)

        const child = this.declare("test", nameOf(name, fn), options, fn)
        const start = (): Promise<Outcome> => child.start(this.run).finally(() => {
            this.active--
        })
        this.active++
        const promise = this.active === 1 ? start() : this.last.then(start)
        this.last = promise
        this.pending.push(promise)
        child.finish = promise

        // A subtest its parent gave up on before it could start never resumes
        // the caller in node:test. Rejecting comes closest without leaving a
        // body hanging, and the run holds a handler for it, so an unawaited
        // call does not surface as an unhandled rejection.
        const settled = promise.then(() => {
            if (!child.started) throw cancelledByParent()
        })
        settled.catch(() => undefined)
        return settled
    }

    // A subtest declared after the verdict goes to the root, as node:test
    // does: it runs after the registered tests, numbered after them, and
    // fails as parentAlreadyFinished whatever its body does.
    private lateSubtest(name: string, options: TestOptions, fn: TestFn | undefined): Promise<void> {
        if (this.run.closed) return Promise.resolve()
        let root: Test = this
        while (root.parent != null) root = root.parent
        const child = root.declare("test", name, options, fn)
        child.late = parentAlreadyFinished()
        return new Promise((resolve) => {
            child.onDone = resolve
        })
    }

    // ---- lifecycle ----

    // Runs this test in its turn. Returns how it ended, for the parent's
    // own verdict; a parent that gave up already knows.
    async start(run: Run): Promise<Outcome> {
        this.run = run
        if (this.closedWith != null) return this.startClosed()
        this.started = true
        this.startedAt = performance.now()

        let closed: Test[] = []
        if (this.kind === "suite") await this.runSuite()
        else closed = await this.runTest()
        // The parent gave up on this test while it ran and reports it, now
        // or once it reaches it: nothing more to say here either way.
        if (this.closedWith != null) return "cancelled"
        this.settle()

        await this.awaitReporting()
        for (const child of closed) await child.report()
        await this.report()
        this.onDone?.()
        return this.outcome
    }

    // A test the parent gave up on before it started. A suite still runs
    // its body, since that is what declares the children node:test would
    // already know about; each of them is closed the moment it is declared.
    private async startClosed(): Promise<Outcome> {
        if (this.kind === "suite" && this.skip == null) {
            // The body still takes time, so the clock runs for it.
            this.started = true
            this.startedAt = performance.now()
            const bodyError = await this.runSuiteBody()
            if (bodyError != null) this.error = bodyError
            for (const child of this.children) await child.start(this.run)
            this.endedAt = performance.now()
        }
        await this.report()
        return this.outcome
    }

    // A descendant that settled on its own may still be reporting. That is
    // bounded, and its results belong ahead of this test's and in the
    // counts, so they are waited for, through the descendants closed here.
    private async awaitReporting(): Promise<void> {
        for (const child of this.children) {
            if (!child.started) continue
            if (child.closedWith != null) await child.awaitReporting()
            else if (child.settled) await child.finish
        }
    }

    // As the parent sees it. A todo's failure never counts against its
    // parent, as in node:test, even under a skip that hides the todo mark; a
    // skip that failed without a todo behind it still does.
    private get outcome(): Outcome {
        if (this.error == null) return this.skip != null ? "skipped" : "passed"
        if (this.todo != null) return "passed"
        return this.cancelled ? "cancelled" : "failed"
    }

    // Decides the verdict, once, and closes whatever is still open below
    // with it handed down, deepest first. The list comes back for the
    // caller to report: a test reports its subtests here, running or
    // queued, while a suite reports its children as it starts each in turn.
    private settle(error?: Error, timedOut = false): Test[] {
        if (this.settled) return []
        this.settled = true
        this.endedAt = performance.now()
        this.cancelled = timedOut && this.late == null
        if (error != null) this.error = this.late ?? error
        else if (this.late != null) this.error = this.late
        const closed: Test[] = []
        const verdict = this.verdictForChildren
        if (verdict != null) {
            const collect = (parent: Test, handed: Verdict): void => {
                for (const child of parent.children) {
                    if (child.settled) continue
                    collect(child, {error: cancelledByParent(), outcome: "cancelled"})
                    child.close(handed)
                    closed.push(child)
                }
            }
            collect(this, verdict)
        }
        return closed
    }

    // ---- suite ----

    private async runSuite(): Promise<void> {
        if (this.skip != null) {
            this.settle()
            return
        }
        let error = await this.runSuiteBody()
        if (error == null) error = await this.runHooks(this.before)

        let failedChildren = 0
        let next = 0
        const runChildren = async (): Promise<void> => {
            for (; next < this.children.length; next++) {
                const outcome = await this.children[next]!.start(this.run)
                if (outcome === "failed" || outcome === "cancelled") failedChildren++
            }
        }
        if (error != null) {
            // Nothing below a broken setup may run.
            this.settle(error)
            for (const child of this.children) await child.start(this.run)
        } else {
            await runChildren()
        }

        // after runs whatever happened above, as it does in node:test.
        const setupError = error
        const afterError = await this.runHooks(this.after)
        error ??= afterError

        if (this.isRoot) {
            // Late subtests join the end of the root's line and run after its
            // teardown, so a timed out body cannot hold that up.
            while (await this.drain()) await runChildren()
            // The root cannot carry a result, so a failing root hook that no
            // child could be charged with is reported on its own and left out
            // of the counts. node:test lets an empty run pass here; a failed
            // setup should never be green, so success is cleared regardless.
            const orphaned = [
                ...(setupError != null && !this.children.length ? [["root before hook", setupError]] : []),
                ...(afterError != null ? [["root after hook", afterError]] : []),
            ] as [string, Error][]
            for (const [name, hookError] of orphaned) {
                await this.run.emit("test:fail", {
                    name, nesting: 0, testNumber: 0,
                    details: {duration_ms: 0, type: "suite", error: hookError},
                })
            }
            if (error != null) this.run.success = false
            return
        }

        if (error == null && failedChildren) {
            error = new TesterError(`${failedChildren} subtest${failedChildren === 1 ? "" : "s"} failed`, "subtestsFailed")
        }
        this.settle(error)
    }

    // The body runs for the first time here, so both the registration of
    // children and an async body settle while the walk is still inside
    // this suite. Its own error, if any, is the suite's to carry.
    private async runSuiteBody(): Promise<Error | undefined> {
        const {harness} = this.run
        const previous = harness.current
        harness.current = this
        harness.openSuites++
        try {
            const body = (this.fn as SuiteFn | undefined)?.({name: this.name})
            if (body != null) await body
            return undefined
        } catch (e) {
            return testRunnerError(e, "testCodeFailure")
        } finally {
            harness.openSuites--
            harness.current = previous
        }
    }

    // Runs the hooks in order and stops at the first failure, which is
    // returned as the error to charge to the suite.
    private async runHooks(list: HookFn[]): Promise<Error | undefined> {
        for (const fn of list) {
            try {
                await fn()
            } catch (e) {
                return testRunnerError(e, "hookFailed")
            }
        }
        return undefined
    }

    // Once the registered tests and the after hooks are done, what is
    // declared by then is all that is left: a body that outlived its
    // timeout is not waited for. One turn is given, since a body that was
    // awaiting the last late subtest resumes only then and may declare more.
    private async drain(): Promise<boolean> {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (this.children.some(child => !child.started && child.closedWith == null)) return true
        this.run.closed = true
        return false
    }

    // ---- test ----

    private async runTest(): Promise<Test[]> {
        const {run} = this
        const skip = skipOf(this.options)
        if (skip != null || this.fn == null) {
            this.settle()
            return []
        }

        // Counted until the body settles, not until the verdict: a body that
        // outlives its timeout is still a body. A synchronous throw becomes a
        // rejection here, so the count comes down the same way in every case.
        const {harness} = run
        harness.openBodies++
        const body = new Promise<void>((resolve) => resolve((this.fn as TestFn)(this.context())))
        void body.finally(() => harness.openBodies--).catch(() => undefined)

        let error: Error | undefined
        let failedSubtests = 0
        let closed: Test[] = []
        try {
            const {timeout} = this.options
            if (timeout != null && timeout > 0) {
                const timer = timeoutAfter(timeout)
                try {
                    await Promise.race([body, timer.promise])
                } catch (e) {
                    // A timer firing after the parent already closed this
                    // test changes nothing: the parent reported it.
                    if (e === timer.error && !this.settled) closed = this.settle(timer.error, true)
                    throw e
                } finally {
                    timer.cancel()
                }
            } else {
                await body
            }
            // An unawaited t.test() is still finished rather than dropped,
            // which is where node:test gives up on it.
            while (this.pending.length && !this.settled) {
                const outcome = await this.pending.shift()
                if (outcome === "failed" || outcome === "cancelled") failedSubtests++
            }
        } catch (e) {
            error = testRunnerError(e, "testCodeFailure")
        }

        if (this.settled) return closed
        // A parent whose subtest failed fails in turn, as in node:test.
        if (error == null && failedSubtests) {
            error = new TesterError(`${failedSubtests} subtest${failedSubtests === 1 ? "" : "s"} failed`, "subtestsFailed")
        }
        // A body that ended with subtests still running gives up on them.
        return this.settle(error)
    }

    // ---- reporting ----

    // Emits test:start for this test and the ancestors still pending, in
    // order. The reporter turns those into headings once a result arrives.
    private async announce(): Promise<void> {
        if (this.announced) return
        this.announced = true
        if (this.parent != null) await this.parent.announce()
        if (this.nesting < 0) return
        await this.run.emit("test:start", {name: this.name, nesting: this.nesting})
    }

    // Counts and emits the result, once. A skip, then a todo, decides the
    // count ahead of the verdict, as in node:test, though the event still
    // carries the failure; a todo's failure does not fail the run, whether
    // or not a skip hides the mark.
    private async report(): Promise<void> {
        if (this.reported || this.isRoot) return
        this.reported = true
        const {counters} = this.run
        const skip = this.skip
        const todo = skip == null ? this.todo : undefined
        if (this.kind === "suite") counters.suites++
        else {
            counters.tests++
            if (skip != null) counters.skipped++
            else if (todo != null) counters.todo++
            else if (this.cancelled) counters.cancelled++
            else if (this.error != null) counters.failed++
            else counters.passed++
        }
        if (this.error != null && this.todo == null) this.run.success = false

        await this.announce()
        const base = {
            name: this.name, nesting: this.nesting, testNumber: this.testNumber,
            ...(skip != null ? {skip} : todo != null ? {todo} : {}),
        }
        const duration_ms = this.started ? (this.endedAt || performance.now()) - this.startedAt : 0
        if (this.error != null) {
            await this.run.emit("test:fail", {...base, details: {duration_ms, type: this.kind, error: this.error}})
        } else {
            await this.run.emit("test:pass", {...base, details: {duration_ms, type: this.kind}})
        }
    }
}
