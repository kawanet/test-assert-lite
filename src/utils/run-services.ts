import type {TAL} from "test-assert-lite"
import {stringify} from "./stringify.ts"

/** What one run offers its parts: where output goes, how it ends, what to undo. */
export interface RunServices {
    /** Receives the page's standard output. */
    stdout: TAL.Writer
    /** Receives the page's standard error and host logs. */
    stderr: TAL.Writer

    /** Finishes successfully after cleanup. */
    resolve: (result: TAL.SessionResult) => void
    /** Fails with the error after cleanup. */
    reject: (error: unknown) => void
    /** The first resolve or reject, settled after cleanup. */
    finished: Promise<TAL.SessionResult>

    /** Runs the registered cleanup functions. */
    cleanup: () => Promise<void>
    /** Register a cleanup function. */
    onCleanup: (fn: () => unknown) => void
}

export interface RunServicesOptions {
    stdout?: TAL.Writer
    stderr?: TAL.Writer
}

const nullWriter: TAL.Writer = {write: (() => undefined)}

const hasProcess = (): boolean => "undefined" !== typeof process && "function" === typeof process.stdout?.write

/** The streams a run falls back on. */
export const getStreams = (streams: RunServicesOptions = {}): Required<RunServicesOptions> => {
    if (hasProcess()) streams = process
    return {
        stdout: streams.stdout ?? nullWriter,
        stderr: streams.stderr ?? nullWriter,
    }
}

/** Creates the services of one run, on either side of the channel. */
export const createRunServices = (options: RunServicesOptions = {}): RunServices => {
    const services = {} as RunServices

    const defaults = getStreams(options)
    services.stdout = options.stdout ?? defaults.stdout
    services.stderr = options.stderr ?? defaults.stderr

    const showError = (e: unknown): void => {
        services.stderr.write(`${stringify(e)}\n`)
    }

    let cleaning = false
    let cleanups = new Promise<void>(resolve => {
        services.cleanup = () => {
            cleaning = true
            resolve()
            return cleanups
        }
    })

    // Cleanup failures remain rejected. Later cleanup functions still run.
    services.onCleanup = (fn) => {
        const run = cleaning ? () => Promise.resolve().then(fn).catch(showError) : fn
        cleanups = cleanups.finally(run)
    }

    // The first resolve or reject owns the result and starts cleanup.
    let finished: Promise<void> | null = null
    services.finished = new Promise((resolve, reject) => {
        services.resolve = (result) => (finished ??= services.cleanup().then(() => resolve(result), reject))
        services.reject = (error) => (finished ??= services.cleanup().catch(showError).finally(() => reject(error)))
    })

    return services as RunServices
}
