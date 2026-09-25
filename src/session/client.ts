// The page's bridge to the CLI: one POST per channel, by a
// path relative to the page, with the fetch it is given. Text is buffered
// per stream and sent in one request per flush, so a burst of a hundred
// console lines is one round trip.

import type {TAL} from "test-assert-lite"
import {delayedBufWriter} from "../utils/buf-writer.ts"

type FetchLike = TAL.FetchLike

export interface SessionClient {
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

const NOP = async () => undefined

const onWrite = (writer: TAL.Writer, fn: () => void): TAL.Writer => {
    return {
        write: (chunk: string) => {
            writer.write(chunk)
            fn()
        },
    }
}

/**
 * Creates the page's bridge to the CLI through `begin`, `stdout`, `stderr`
 * and `end`. Sending never rejects. The page can do nothing about a CLI
 * that went away.
 */
export const createBridgeClient = (fetch: FetchLike): SessionClient => {
    return heartbeatClient(bufferClient(bridgeToClient(inOrderBridge(fetchToBridge(fetch)))))
}

export const heartbeatClient = (client: SessionClient): SessionClient => {
    let alive: ReturnType<typeof setInterval> | null = null
    let started = 0
    let last = 0

    const tack = () => (last = Date.now())
    const {stdout, stderr} = client

    const tick = (): void => {
        if (Date.now() - last < QUIET_MS) return
        stderr.write(`⏳ ${Math.round((Date.now() - started) / 1000)}s\n`)
    }

    return {
        begin: () => {
            last = Date.now()
            started ||= last
            alive ??= setInterval(tick, TICK_MS)
            return client.begin()
        },
        stdout: onWrite(stdout, tack),
        stderr: onWrite(stderr, tack),
        end: async (result) => {
            if (alive != null) clearInterval(alive)
            alive = null
            return client.end(result)
        },
    }
}

export const bufferClient = (client: SessionClient): SessionClient => {
    const stdout = delayedBufWriter(client.stdout, FLUSH_MS)
    const stderr = delayedBufWriter(client.stderr, FLUSH_MS)

    return {
        begin: () => {
            stdout.flush()
            stderr.flush()
            return client.begin()
        },
        stdout: {
            write: (chunk) => {
                stderr.flush()
                stdout.write(chunk)
            },
        },
        stderr: {
            write: (chunk) => {
                stdout.flush()
                stderr.write(chunk)
            },
        },
        end: (result) => {
            stdout.flush()
            stderr.flush()
            return client.end(result)
        },
    }
}

const bridgeToClient = (bridge: TAL.BridgeAPI): SessionClient => {
    return {
        begin: () => bridge.send({type: "session:begin"}).then(NOP, NOP),
        stdout: {write: (chunk) => bridge.stdout(chunk).catch(NOP)},
        stderr: {write: (chunk) => bridge.stderr(chunk).catch(NOP)},
        end: (data) => bridge.send({type: "session:end", data}).then(NOP, NOP),
    }
}

export const inOrderBridge = (bridge: TAL.BridgeAPI): TAL.BridgeAPI => {
    // Every request follows the one before, so each stream stays in order.
    let inflight: Promise<void> = Promise.resolve()

    // Request failures are ignored. Later requests are still attempted.
    const chain = (fn: () => Promise<unknown>): Promise<void> => {
        return inflight = inflight.then(fn).then(NOP, NOP)
    }

    return {
        stdout: chunk => chain(() => bridge.stdout(chunk)),
        stderr: chunk => chain(() => bridge.stderr(chunk)),
        send: message => chain(() => bridge.send(message)),
    }
}

export const fetchToBridge = (fetch: FetchLike): TAL.BridgeAPI => {
    return {
        stdout: chunk => fetch("stdout", {method: "POST", body: chunk}),
        stderr: chunk => fetch("stderr", {method: "POST", body: chunk}),
        send: message => fetch("send", {method: "POST", body: JSON.stringify(message)}),
    }
}
