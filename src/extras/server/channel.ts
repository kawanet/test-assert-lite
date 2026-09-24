// The CLI's side of the channel to the page it drives: the run's own path,
// which only this process and that page know, and the endpoints under it
// the page reports to, as the page's bridge sends: begin, the two streams
// and the verdict at the end. What comes in goes to the streams given;
// nothing changes in the protocol here without the same change in that bridge.

import type {TAL} from "test-assert-lite"
import type {RunServices} from "../../utils/run-services.ts"
import {stringify} from "../../utils/stringify.ts"
import type {ContextLike, Next} from "./middleware.ts"

export interface ChannelOptions {
    /** The run's streams, outcome and cleanup, shared by every part. */
    services: RunServices
    /** Prefix for channel path: `/@tal/run/xxxxxxxxx/` */
    prefix: string
    /** Allowed silence in milliseconds; 30 seconds for a single run, unlimited otherwise. */
    timeout?: number
    /** Finishes after the first test run. Defaults to `true`. */
    singleRun?: boolean
}

export interface Channel {
    /** Takes the page's reports, each a POST under the path, and answers 204; 405 to any other method. */
    handler: (c: ContextLike, next: Next) => Promise<Response | void>
}

type SessionEventType = TAL.SessionEvent["type"]

type SessionEventData<T extends SessionEventType> = Extract<TAL.SessionEvent, {type: T}>["data"]

const isTestResult = (v: unknown): v is TAL.SessionResult => ("boolean" === typeof (v as TAL.SessionResult)?.success)

// How long a browser run, --playwright or --webdriver, may stay silent.
// Before begin, the browser most likely could not reach the server. After
// begin, a quiet page still reports every ten seconds, so this long means
// the browser or its tab is gone. A hung test keeps reporting, so it waits.
const SILENCE_MS = 30_000

/**
 * Creates the endpoints that receive the page's reports and result.
 * Applies a silence timeout when configured or running once.
 */
export const createChannel = ({prefix, services, timeout, singleRun = true}: ChannelOptions): Channel => {
    let begun = false
    let ended = false
    let timer: ReturnType<typeof setTimeout> | null = null
    if (singleRun) timeout ??= SILENCE_MS

    const heard = (): void => {
        if (timer != null) clearTimeout(timer)
        if (ended) return
        timer = setTimeout(() => {
            if (begun) {
                services.reject(new Error(`No word from the page for ${timeout! / 1000} seconds: the browser, its tab or the session is gone`))
            } else {
                services.reject(new Error("The page never reported in: could the browser reach the server?"))
            }
        }, timeout)
    }

    type SessionEventMap = {[T in SessionEventType]: (body: SessionEventData<T>) => undefined | number}

    const eventMap: SessionEventMap = {
        "session:begin": (data) => {
            if (data) return 400
            begun = true
        },
        "session:end": (data) => {
            if (!isTestResult(data)) return 400
            if (singleRun) services.resolve(data)
            ended = true
        },
    }

    const eventTypes = Object.keys(eventMap)
    const isSessionEvent = (v: unknown): v is TAL.SessionEvent => eventTypes.includes((v as TAL.SessionEvent)?.type)

    const channels: Record<TAL.BridgeChannel, (body: string) => undefined | number> = {
        stdout: (body) => void services.stdout.write(body),
        stderr: (body) => void services.stderr.write(body),
        ipcout: <T extends SessionEventType>(body: string) => {
            try {
                const message = body ? JSON.parse(body) as TAL.SessionEvent : undefined
                if (!isSessionEvent(message)) return 400
                const fn = eventMap[message.type as T]
                if (!fn) return
                fn(message.data as SessionEventData<T>)
            } catch (e) {
                services.stderr.write(`${stringify(e)}\n`)
                return 400
            }
        },
    }

    const channelNames = Object.keys(channels)
    const isChannelName = (v: string): v is TAL.BridgeChannel => channelNames.includes(v)

    const handler = async (c: ContextLike, next: Next) => {
        if (!c.req.path.startsWith(prefix)) return next()
        const channelName = c.req.path.slice(prefix.length)
        const channelFn = isChannelName(channelName) && channels[channelName]
        if (!channelFn) return next()
        if (c.req.method !== "POST") return c.body(null, 405, {allow: "POST"})
        const status = channelFn(await c.req.text()) ?? 204
        if (timeout) heard()
        return c.body(null, status)
    }

    if (timeout) {
        services.onCleanup(() => {
            if (timer != null) clearTimeout(timer)
        })
        heard()
    }

    return {handler}
}
