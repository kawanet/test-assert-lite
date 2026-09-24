// The page's bridge to the CLI: one POST per channel, by a
// path relative to the page, with the fetch it is given. Text is buffered
// per stream and sent in one request per flush, so a burst of a hundred
// console lines is one round trip.

import type {TAL} from "test-assert-lite"
import {createBufWriter} from "../utils/buf-writer.ts"

type FetchLike = TAL.FetchLike

export interface Bridge {
    /** Tells the CLI the page is up; it waits for this with a timeout. */
    begin: () => Promise<void>

    /** Text for the CLI's stdout, buffered. */
    stdout: TAL.Writer

    /** Text for the CLI's stderr, buffered. */
    stderr: TAL.Writer

    /** The verdict as JSON, sent once the buffers have drained. */
    end: (result: TAL.SessionResult) => Promise<void>
}

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
 * Creates the page's bridge to the CLI through `begin`, `stdout`, `stderr`
 * and `end`. Sending never rejects. The page can do nothing about a CLI
 * that went away.
 */
export const createBridgeClient = (fetch: FetchLike): Bridge => {
    const stdoutBuf = createBufWriter()
    const stderrBuf = createBufWriter()
    let timer: ReturnType<typeof setTimeout> | null = null
    let alive: ReturnType<typeof setInterval> | null = null
    let started = 0
    let last = 0
    // Every request follows the one before, so each stream stays in order.
    let inflight: Promise<void> = Promise.resolve()

    // Request failures are ignored. Later requests are still attempted.
    const post = (channel: TAL.BridgeChannel, body: string): Promise<void> => {
        inflight = inflight
            .then(() => fetch(channel, {method: "POST", body}))
            .then(() => undefined, () => undefined)
        return inflight
    }

    const send: TAL.BridgeAPI["send"] = async (message) => {
        await flush()
        return post("ipcout", JSON.stringify(message))
    }

    const flush = (): Promise<void> => {
        if (timer != null) clearTimeout(timer)
        timer = null
        // Emptied and queued in one synchronous step, so end() cannot get ahead.
        const stdoutText = stdoutBuf.read()
        const stderrText = stderrBuf.read()
        if (stdoutText) void post("stdout", stdoutText)
        if (stderrText) void post("stderr", stderrText)
        return inflight
    }

    // A write arms the flush and counts as a word from the page.
    const wrap = (writer: TAL.Writer): TAL.Writer => {
        return {
            write: (chunk: string) => {
                writer.write(chunk)
                last = Date.now()
                timer ??= setTimeout(flush, FLUSH_MS)
            },
        }
    }

    const stdout = wrap(stdoutBuf)
    const stderr = wrap(stderrBuf)

    const tick = (): void => {
        if (Date.now() - last < QUIET_MS) return
        stderr.write(`⏳ ${Math.round((Date.now() - started) / 1000)}s\n`)
    }

    return {
        begin: () => {
            started = last = Date.now()
            alive ??= setInterval(tick, TICK_MS)
            return send({type: "session:begin"})
        },
        stdout,
        stderr,
        end: async (result) => {
            if (alive != null) clearInterval(alive)
            alive = null
            return send({type: "session:end", data: result})
        },
    }
}
