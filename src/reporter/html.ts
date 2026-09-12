import type * as declared from "test-assert-lite"
import {$$} from "../utils/stringify.ts"
import {errorText, isSubtestsFailed} from "../utils/tester-error.ts"
import {directive} from "./spec.ts"

type TestEvent = declared.TAL.TestEvent
type FormatFn = declared.TAL.FormatFn

const indentClass = (indent: number): string => (indent > 0 ? `tal-i${indent > 5 ? 5 : indent}` : "")

const resultLine = (data: declared.TAL.TestPass | declared.TAL.TestFail, isPass: boolean, indented: boolean): string => {
    const skipped = data.skip != null
    const todo = !skipped && data.todo != null
    const kind = skipped ? "skip" : isPass ? "pass" : todo ? "warn" : "fail"
    const symbol = skipped ? "﹣" : isPass ? "✔" : todo ? "⚠" : "✖"
    const note = directive(data)
    const indents = indented ? indentClass(indented && data.nesting) : ""
    const ms = data.details.duration_ms.toFixed(3)
    return $$`<div class="tal-r ${indents}"><span class="tal-${kind}">${symbol} ${data.name}</span> <span class="tal-info">(${ms}ms)</span>${note}</div>\n`
}

const formatFailures = (failed: declared.TAL.TestFail[]): string => {
    if (!failed.length) return ""
    let out = $$`<div class="tal-r tal-fail">✖ failing tests:</div>\n`
    for (const data of failed) {
        out += resultLine(data, false, false)
        out += $$`<div class="tal-r tal-error"><pre>${errorText(data.details.error)}</pre></div>\n`
    }
    return out
}

// Produces list items only, leaving the surrounding list and output target
// to the page so applications can place the report in their own layout.
export const html = (): FormatFn => async function* (source: AsyncIterable<TestEvent>): AsyncIterable<string> {
    const stack: declared.TAL.TestStart[] = []
    const failed: declared.TAL.TestFail[] = []

    for await (const event of source) {
        if (event.type === "test:start") {
            stack.unshift(event.data)
            continue
        }

        if (event.type === "test:diagnostic") {
            const {level, nesting, message} = event.data
            yield $$`<div class="tal-r ${indentClass(nesting)}"><span class="tal-${level}">ℹ ${message}</span></div>`
            continue
        }

        // The run's summary carries no `file`; a per-file one from node does.
        if (event.type === "test:summary") {
            if (!("file" in event.data)) {
                yield formatFailures(failed)
                failed.length = 0
            }
            continue
        }

        const isPass = event.type === "test:pass"
        const isFail = event.type === "test:fail"
        if (!isPass && !isFail) continue

        const data = event.data
        let out = ""
        if (stack.length && stack[0]?.name === data.name) stack.shift()
        while (stack.length) {
            const parent = stack.pop()
            if (parent) {
                out += $$`<div class="tal-r ${indentClass(parent.nesting)}"><span class="tal-suite">▶ ${parent.name}</span></div>\n`
            }
        }
        out += resultLine(data, isPass, true)
        if (isFail) {
            const failure = data as declared.TAL.TestFail
            if (!isSubtestsFailed(failure.details.error)) failed.push(failure)
        }
        yield out
    }

    yield formatFailures(failed)
}
