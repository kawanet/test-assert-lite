import type {TAL} from "test-assert-lite"
import type {HarnessState} from "../session/state.ts"
import {TesterError, cancelledByParent, parentAlreadyFinished, testRunnerError} from "../utils/tester-error.ts"
import type {Args} from "./declare.ts"
import {nameOf, normalize, skipOf, todoOf} from "./declare.ts"
import type {Outcome} from "./job.ts"
import {Job} from "./job.ts"

type TestOptions = TAL.TestOptions
type TestFn = TAL.TestFn
type SuiteFn = TAL.SuiteFn

export type Kind = "suite" | "test"

const timeoutAfter = (ms: number): {promise: Promise<never>, error: TesterError, cancel: () => void} => {
    let timer: ReturnType<typeof setTimeout>
    const error = new TesterError(`test timed out after ${ms}ms`, "testTimeoutFailure")
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error), ms)
    })
    return {promise, error, cancel: () => clearTimeout(timer)}
}

// One test: it runs its body with a t of its own, takes the subtests the
// body declares, and reports itself the way node:test reports a test.
export class Tester extends Job {
    declare readonly parent: Tester | null
    readonly kind: Kind = "test"
    readonly options: TestOptions
    readonly fn: TestFn | SuiteFn | undefined
    readonly harness: HarnessState

    private reported = false
    // A skip called from the body outranks the one it was declared with.
    private skipped: string | true | undefined
    // Declared, called from the body, or inherited: a todo's subtests are
    // todo as well, as in node:test, though only as a bare mark.
    private todo: string | true | undefined

    // node:test runs subtests one at a time: a new one waits for the
    // previous one, awaited or not, while the first starts synchronously.
    private last: Promise<unknown> = Promise.resolve()
    private active = 0
    private pending: Promise<Outcome>[] = []

    constructor(name: string, options: TestOptions, fn: TestFn | SuiteFn | undefined, parent: Tester | null, harness: HarnessState) {
        super(name, parent)
        this.options = options
        this.fn = fn
        this.harness = harness
        this.todo = todoOf(options) ?? (parent?.todo != null ? true : undefined)
    }

    // Declares a child test in the next slot.
    declareTest(name: string, options: TestOptions, fn: TestFn | undefined): Tester {
        return this.adopt(new Tester(name, options, fn, this, this.harness))
    }

    protected get skip(): string | true | undefined {
        return this.skipped ?? skipOf(this.options)
    }

    // ---- what t gives a body ----

    private context(): TAL.TestContext {
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
                // after the report has no place to go. The call is synchronous,
                // as node's is. A reporter failure reaches the run through the
                // next awaited event, so this one has nothing to add.
                if (this.settled) return
                void this.run.emit("test:diagnostic", {message, nesting: this.nesting, level: "info"}).catch(() => undefined)
            },
            test: (...args: Args<TestFn>) => this.subtest(args),
        }
    }

    private subtest(args: Args<TestFn>): Promise<void> {
        const {name, options, fn} = normalize<TestFn>(args)
        if (this.settled) return this.lateSubtest(nameOf(name, fn), options, fn)

        const child = this.declareTest(nameOf(name, fn), options, fn)
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
        let root: Tester = this
        while (root.parent != null) root = root.parent
        const child = root.declareTest(name, options, fn)
        child.late = parentAlreadyFinished()
        return new Promise((resolve) => {
            child.onDone = resolve
        })
    }

    // ---- lifecycle ----

    protected override async runBody(): Promise<Job[]> {
        const skip = skipOf(this.options)
        if (skip != null || this.fn == null) {
            this.settle()
            return []
        }

        // Counted until the body settles, not until the verdict: a body that
        // outlives its timeout is still a body. A synchronous throw becomes a
        // rejection here, so the count comes down the same way in every case.
        const {harness} = this
        harness.openBodies++
        const body = new Promise<void>((resolve) => resolve((this.fn as TestFn)(this.context())))
        void body.finally(() => harness.openBodies--).catch(() => undefined)

        let error: Error | undefined
        let failedSubtests = 0
        let closed: Job[] = []
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

    // A todo's failure never counts against its parent, as in node:test,
    // even under a skip that hides the todo mark; a skip that failed
    // without a todo behind it still does.
    protected override get outcome(): Outcome {
        if (this.error == null) return this.skip != null ? "skipped" : "passed"
        if (this.todo != null) return "passed"
        return super.outcome
    }

    // ---- reporting ----

    // Counts this in the run, the way node:test counts a test of this kind.
    protected count(skip: string | true | undefined, todo: string | true | undefined): void {
        const {counters} = this.run
        counters.tests++
        if (skip != null) counters.skipped++
        else if (todo != null) counters.todo++
        else if (this.cancelled) counters.cancelled++
        else if (this.error != null) counters.failed++
        else counters.passed++
    }

    // Counts and emits the result, once. A skip, then a todo, decides the
    // count ahead of the verdict, as in node:test, though the event still
    // carries the failure; a todo's failure does not fail the run, whether
    // or not a skip hides the mark.
    protected override async report(): Promise<void> {
        if (this.reported) return
        this.reported = true
        const skip = this.skip
        const todo = skip == null ? this.todo : undefined
        this.count(skip, todo)
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
