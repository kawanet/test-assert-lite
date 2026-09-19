import type {TAL} from "test-assert-lite"
import {html} from "../reporter/html.ts"
import {spec} from "../reporter/spec.ts"
import {tap} from "../reporter/tap.ts"
import {isError} from "../utils/is-error.ts"
import {stringify} from "../utils/stringify.ts"
import {errorText} from "../utils/tester-error.ts"
import {client} from "./client.ts"
import {withFooter} from "./footer.ts"
import type {ReportStream} from "./report-stream.ts"
import type {HarnessState} from "./state.ts"

type ReporterFn = TAL.ReporterFn
type OutputFn = TAL.OutputFn
type SessionOptions = TAL.SessionOptions
type Writer = TAL.Writer
type EventTargetLike = TAL.EventTargetLike
type ConsoleLike = TAL.ConsoleLike

// What a run reports with: opened by session(), or with the defaults on
// the first declaration, until end() closes it with the verdict.
interface Open {
    reporter: ReporterFn
    output: OutputFn
    end: (success: boolean) => Promise<void>
    // Opened by a declaration rather than by session(): the refusal differs.
    auto: boolean
    // Lets go of what the session took: the errors outside the tests, and the console.
    release: () => void
}

export interface SessionControl {
    session: TAL.SessionAPI["session"]
    // Closes the session with the run's verdict; nothing to close is fine.
    close: (success: boolean) => Promise<void>
    // Opens the default session unless one is open already.
    open: () => void
    // Gives a run's stream the settings of the session.
    attach: (stream: ReportStream) => void
    stdout: Writer
    stderr: Writer
}

// One of the two streams. With a sink the text goes through as it comes;
// without one, before a session and after it, the text is held.
interface Outlet extends Writer {
    connect: (sink: (text: string) => void) => void
    disconnect: () => void
}

const textOf = (chunk: string | Error): string => {
    if ("string" === typeof chunk) return chunk
    const text = errorText(chunk)
    return text.endsWith("\n") ? text : `${text}\n`
}

const outlet = (): Outlet => {
    let sink: ((text: string) => void) | null = null
    let held = ""
    return {
        write: chunk => {
            const text = textOf(chunk)
            if (sink != null) sink(text)
            else held += text
        },
        connect: fn => {
            sink = fn
            const text = held
            held = ""
            if (text) fn(text)
        },
        disconnect: () => {
            sink = null
        },
    }
}

// A base under a run's own URL connects the page to the CLI; any other
// base means nothing here.
const CHANNEL = /^\/@tal\/run\//

// The console as it was when this module loaded, ahead of any page code:
// what a page's session takes over never loops back through here.
const native = {stdout: console.log, stderr: console.error}

// Node's process streams where they exist, the console as loaded otherwise.
const local = (name: "stdout" | "stderr"): ((text: string) => void) => {
    const stream = "undefined" !== typeof process ? process[name] : undefined
    if (stream?.write != null) return text => void stream.write(text)
    const log = native[name]
    return text => log(text.replace(/\n$/, ""))
}

// The suites are served under a digest-named directory; the name a
// person knows is what follows it.
const SERVED = /^\/@tal\/files\/[0-9a-f]{9}\//

// The uncaught errors and unhandled rejections of a window, or of what
// stands in for one, each one failed test at the root, named after the
// script it came from where the event says, as a suite that threw is
// under Node. Declared on the root itself, since one may arrive while a
// test body is open, and the walk takes it.
const capture = (harness: HarnessState, target: EventTargetLike): (() => void) => {
    const take = (name: string, error: unknown): void => {
        harness.root.declareTest(name, {}, () => {
            throw error
        })
    }
    const nameOf = (url: string | undefined): string | undefined => {
        try {
            return url ? new URL(url).pathname.replace(SERVED, "") : undefined
        } catch {
            return url
        }
    }
    const onError = (event: unknown): void => {
        const {error, message, filename, target} = event as Partial<ErrorEvent>
        const src = (target as {src?: string} | null | undefined)?.src
        const name = nameOf(filename || src) ?? "error"
        take(name, error ?? new Error(message || `failed to load ${name}`))
    }
    const onRejection = (event: unknown): void => {
        take("unhandled rejection", (event as Partial<PromiseRejectionEvent>).reason)
    }
    target.addEventListener("error", onError, true)
    target.addEventListener("unhandledrejection", onRejection)
    return () => {
        target.removeEventListener("error", onError, true)
        target.removeEventListener("unhandledrejection", onRejection)
    }
}

// The console's methods go to the writers until released, a call a line:
// a string as it is, an Error with its stack, anything else as an
// assertion would show it.
const STDOUT_LEVELS = ["log", "info", "debug"] as const
const STDERR_LEVELS = ["warn", "error"] as const
type Level = keyof ConsoleLike

const consoleLine = (args: unknown[]): string =>
    `${args.map(v => "string" === typeof v ? v : isError(v) ? errorText(v) : stringify(v)).join(" ")}\n`

const takeConsole = (target: ConsoleLike, stdout: Writer, stderr: Writer): (() => void) => {
    const saved = new Map<Level, ConsoleLike[Level]>()
    const take = (level: Level, writer: Writer): void => {
        saved.set(level, target[level])
        target[level] = (...args) => writer.write(consoleLine(args))
    }
    for (const level of STDOUT_LEVELS) take(level, stdout)
    for (const level of STDERR_LEVELS) take(level, stderr)
    return () => {
        for (const [level, fn] of saved) target[level] = fn
    }
}

// What takes a listener: a window has it, Node's global does not.
const isEventTarget = (value: unknown): value is EventTargetLike => {
    const v = value as Partial<EventTargetLike> | null | undefined
    return "function" === typeof v?.addEventListener && "function" === typeof v?.removeEventListener
}

// true is the window, where there is one; under Node, whose errors nothing
// takes yet, true means nothing. Anything else is listened on as given.
const targetOf = (capture: SessionOptions["capture"]): EventTargetLike | undefined => {
    const target = capture === true ? globalThis : capture
    return isEventTarget(target) ? target : undefined
}

const reporterMap = new Map<string, () => ReporterFn>([
    ["html", html],
    ["spec", spec],
    ["tap", tap],
])

export const createSessions = (harness: HarnessState): SessionControl => {
    let current: Open | null = null
    const stdout = outlet()
    const stderr = outlet()

    // An unsupported reporter becomes a root failure. With none named,
    // the session uses spec and lets quiet tune it.
    const reporterOf = (v: ReporterFn | string | undefined): ReporterFn | undefined => {
        if (!v) return undefined
        if ("function" === typeof v) return v
        const init = reporterMap.get(v)
        if (init) return init()
        return lazyReporter(v)
    }

    // A module name is imported when the run starts reporting, its default
    // export the reporter, as node --test-reporter takes one. A name that
    // does not import, or starts with "." and would resolve against this
    // module, is a failed test at the root, and the run goes on with spec.
    const lazyReporter = (v: string): ReporterFn => {
        return async function* (source) {
            let error: Error | null = null
            const module = /^\./.test(v) ? null : await import(v).catch((e: Error) => (void (error = e)))
            let reporter: unknown = module?.default
            if (error || "function" !== typeof reporter) {
                harness.root.declareTest(`import(${JSON.stringify(v)})`, {}, () => {
                    throw error || new Error(`unsupported reporter: ${v}`)
                })
                reporter = spec()
            }
            yield* (reporter as ReporterFn)(source)
        }
    }

    const create = (options: SessionOptions, auto: boolean): Open => {
        const {base} = options
        // The footer is the session's to leave off, for a script that is no suite.
        const named = reporterOf(options.reporter) ?? spec({quiet: options.quiet})
        const reporter = options.quiet ? named : withFooter(named)
        const url = base == null ? null : new URL(base)
        // The report goes where the console goes unless told otherwise.
        const output = options.output ?? ((text: string) => stdout.write(text))
        const opened = (open: Omit<Open, "release" | "auto">): Open => {
            const target = targetOf(options.capture)
            const releaseErrors = target == null ? () => undefined : capture(harness, target)
            const releaseConsole = options.console == null ? () => undefined : takeConsole(options.console, stdout, stderr)
            const release = (): void => {
                releaseErrors()
                releaseConsole()
            }
            return {...open, auto, release}
        }
        if (url != null && CHANNEL.test(url.pathname)) {
            const channel = client(url)
            void channel.begin()
            stdout.connect(channel.stdout)
            stderr.connect(channel.stderr)
            return opened({reporter, output, end: channel.end})
        }
        stdout.connect(local("stdout"))
        stderr.connect(local("stderr"))
        return opened({reporter, output, end: async () => undefined})
    }

    const session: TAL.SessionAPI["session"] = (options = {}) => {
        if (current != null) {
            throw new Error(current.auto ? "session() must come before the first test is declared" : "session() is already open")
        }
        current = create(options, false)
    }

    const close = async (success: boolean): Promise<void> => {
        const open = current
        if (open == null) return
        current = null
        stdout.disconnect()
        stderr.disconnect()
        open.release()
        await open.end(success)
    }

    return {
        session,
        close,
        open: () => {
            current ??= create({}, true)
        },
        attach: (stream) => {
            current ??= create({}, true)
            stream.attach(current.reporter, current.output)
        },
        stdout,
        stderr,
    }
}
