import type * as declared from "test-assert-lite"
import {errorText, isSubtestsFailed} from "../utils/tester-error.ts"

type TestEvent = declared.TAL.TestEvent
type FormatFn = declared.TAL.FormatFn

const SYMBOL = {
    pass: "✔ ",
    fail: "✖ ",
    skip: "﹣ ",
    warn: "⚠ ",
    info: "ℹ ",
    suite: "▶ ",
} as const

const COLOR = {
    green: "\u001b[32m",
    red: "\u001b[31m",
    blue: "\u001b[34m",
    yellow: "\u001b[33m",
    gray: "\u001b[90m",
    reset: "\u001b[39m",
} as const

// Node enables colour only for a TTY, while honouring NO_COLOR and
// NODE_DISABLE_COLORS. A browser has no terminal, so colour stays off there.
const defaultColors = (): boolean => {
    const node = "undefined" !== typeof process
        && (process as {env?: Record<string, string | undefined>, stdout?: {isTTY?: boolean}})
    const env = node && node.env
    return !!node && !!node.stdout?.isTTY && !!env && (!env.NO_COLOR && !env.NODE_DISABLE_COLORS)
}

const indent = (nesting: number): string => "  ".repeat(nesting)

const paint = (on: boolean, color: string, text: string): string => on ? `${color}${text}${COLOR.reset}` : text

// The note after a result: the skip's or the todo's reason, or its bare mark.
export const directive = (data: declared.TAL.TestPass | declared.TAL.TestFail): string => {
    const mark = data.skip != null ? ["SKIP", data.skip] as const : data.todo != null ? ["TODO", data.todo] as const : undefined
    if (mark == null) return ""
    return ` # ${"string" === typeof mark[1] && mark[1] ? mark[1] : mark[0]}`
}

// One result line: symbol, name, duration and note. A skip outranks the
// verdict in the symbol, so a skipped failure still reads as skipped; a
// failed todo is a warning rather than a failure, as node:test's spec has it.
const resultLine = (data: declared.TAL.TestPass | declared.TAL.TestFail, isPass: boolean, colors: boolean, indented: boolean): string => {
    const skipped = data.skip != null
    const todo = !skipped && data.todo != null
    const symbol = skipped ? SYMBOL.skip : isPass ? SYMBOL.pass : todo ? SYMBOL.warn : SYMBOL.fail
    const color = skipped ? COLOR.gray : isPass ? COLOR.green : todo ? COLOR.yellow : COLOR.red
    const note = directive(data)
    const ms = paint(colors, COLOR.gray, ` (${data.details.duration_ms.toFixed(3)}ms)`)
    return paint(colors, color, `${indented ? indent(data.nesting) : ""}${symbol}${data.name}`) + ms + note
}

const formatFailures = (failed: declared.TAL.TestFail[], colors: boolean): string => {
    if (!failed.length) return ""
    let out = "\n" + paint(colors, COLOR.red, `${SYMBOL.fail}failing tests:`) + "\n"
    for (const data of failed) {
        out += "\n" + resultLine(data, false, colors, false) + "\n"
        out += "  " + errorText(data.details.error).replace(/\n/g, "\n  ") + "\n"
    }
    return out
}

export const spec = (options?: declared.TAL.SpecOptions): FormatFn => {
    const colors = options?.colors ?? defaultColors()

    return async function* (source: AsyncIterable<TestEvent>): AsyncIterable<string> {
        // Stack up test:start and, once a result arrives, emit the parents
        // still pending as headings. This is how node:test's spec builds it.
        const stack: declared.TAL.TestStart[] = []
        const failed: declared.TAL.TestFail[] = []

        for await (const event of source) {
            if (event.type === "test:start") {
                stack.unshift(event.data)
                continue
            }

            if (event.type === "test:diagnostic") {
                const {level, nesting, message} = event.data
                const color = level === "error" ? COLOR.red : level === "warn" ? COLOR.yellow : COLOR.blue
                yield paint(colors, color, `${indent(nesting)}${SYMBOL.info}${message}`) + "\n"
                continue
            }

            // node emits a summary per file, with `file`, and one for the run
            // without it; the list goes with the latter, as in node's spec.
            if (event.type === "test:summary") {
                if (!("file" in event.data)) {
                    yield formatFailures(failed, colors)
                    failed.length = 0
                }
                continue
            }

            // Under node --test the source carries more types than these,
            // so check for a result event rather than assuming one. An
            // unknown type is dropped, as it is in node:test's spec.
            const isPass = event.type === "test:pass"
            const isFail = event.type === "test:fail"
            if (!isPass && !isFail) continue

            const data = event.data
            let out = ""

            // Drop this test's own start, then turn the remaining parents into headings
            if (stack.length && stack[0]?.name === data.name) stack.shift()
            while (stack.length) {
                const parent = stack.pop()!
                out += paint(colors, COLOR.gray, `${indent(parent.nesting)}${SYMBOL.suite}${parent.name}`) + "\n"
            }

            out += resultLine(data, isPass, colors, true) + "\n"

            if (isFail && !isSubtestsFailed(event.data.details.error)) failed.push(event.data)
            yield out
        }

        // A caller that never sends the run's summary still gets the list.
        yield formatFailures(failed, colors)
    }
}
