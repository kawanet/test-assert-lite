// The page's side of the channel to the CLI: one call per endpoint under
// the run's base URL. Text is buffered per stream and sent in one request
// per flush, so a burst of a hundred console lines is one round trip.
// Node's fetch() is all it uses, so it runs anywhere with a base to reach.

import type * as declared from "test-assert-lite"
import {errorText} from "../utils/tester-error.ts"

type Client = declared.TAL.Client
type Stream = "stdout" | "stderr"

// How long lines gather before a flush: a test's burst of output becomes
// one request, while a person watching still sees it as it comes.
const FLUSH_MS = 50

// A quiet page says so every ten seconds, on stderr: the CLI takes any
// word within its own, longer bound as proof the page is alive, and a
// person watching sees a long test is still going rather than hung. The
// check runs each second, so the line lands on time rather than a beat late.
const QUIET_MS = 10_000
const TICK_MS = 1_000

/**
 * Connects to the CLI at `base`, the run's URL ending in "/". Sending
 * never rejects: the page can do nothing about a CLI that went away.
 */
export const client = (base: string | URL): Client => {
    const buffers: Record<Stream, string> = {stdout: "", stderr: ""}
    let timer: ReturnType<typeof setTimeout> | null = null
    let alive: ReturnType<typeof setInterval> | null = null
    let started = 0
    let last = 0
    // Every request follows the one before, so each stream stays in order.
    let inflight: Promise<void> = Promise.resolve()

    const post = (path: string, body: string): Promise<void> => {
        inflight = inflight
            .then(() => fetch(new URL(path, base), {method: "POST", body}))
            .then(() => undefined, () => undefined)
        return inflight
    }

    const flush = (): Promise<void> => {
        if (timer != null) clearTimeout(timer)
        timer = null
        for (const stream of ["stdout", "stderr"] as const) {
            const text = buffers[stream]
            if (!text) continue
            buffers[stream] = ""
            void post(stream, text)
        }
        return inflight
    }

    // stderr holds lines, as node keeps a test's stderr in lines: an Error
    // becomes its text, and a line that lacks its newline gets one.
    const line = (item: string | Error): string => {
        const text = errorText(item)
        return text.endsWith("\n") ? text : `${text}\n`
    }

    const write = (stream: Stream, text: string): void => {
        buffers[stream] += text
        last = Date.now()
        timer ??= setTimeout(flush, FLUSH_MS)
    }

    const tick = (): void => {
        if (Date.now() - last < QUIET_MS) return
        write("stderr", `⏳ ${Math.round((Date.now() - started) / 1000)}s\n`)
    }

    return {
        begin: () => {
            started = last = Date.now()
            alive ??= setInterval(tick, TICK_MS)
            return post("begin", "")
        },
        stdout: text => write("stdout", text),
        stderr: item => write("stderr", line(item)),
        end: async success => {
            if (alive != null) clearInterval(alive)
            alive = null
            await flush()
            await post("end", JSON.stringify(success === true))
        },
    }
}
