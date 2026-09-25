// Writers that hold text: what the session and the client buffer with,
// and what a test reads back.

import type {TAL} from "test-assert-lite"

// Holds what is written until read() takes it, all at once.
interface BufWriter extends TAL.Writer {
    read: () => string
}

interface DelayedWriter extends TAL.Writer {
    flush: () => void
}

// Holds the text until a writer is connected, then passes it through as it
// comes. Disconnected, it holds again.
interface ConnectWriter extends TAL.Writer {
    connect: (writer: TAL.Writer) => void
    disconnect: () => void
}

export const createBufWriter = (): BufWriter => {
    const buf: string[] = []

    return {
        write: (chunk) => void buf.push(chunk),
        read: () => !buf.length ? "" : buf.splice(0).join(""),
    }
}

export const delayedBufWriter = (writer: TAL.Writer, interval: number): DelayedWriter => {
    const buf = createBufWriter()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
        if (timer != null) clearTimeout(timer)
        timer = null
        const chunk = buf.read()
        if (chunk) writer.write(chunk)
    }

    return {
        write: (chunk) => {
            buf.write(chunk)
            timer ??= setTimeout(flush, interval)
        },
        flush,
    }
}

export const createConnectWriter = (): ConnectWriter => {
    const buf = createBufWriter()
    let connected: TAL.Writer | undefined = undefined

    return {
        write: (chunk) => (connected ?? buf).write(chunk),
        connect: (writer) => {
            const text = buf.read()
            connected = writer
            if (text) writer.write(text)
        },
        disconnect: () => (connected = undefined),
    }
}

// The writer alone, for the public API: connect() and read() stay inside.
export const pureWriter = (writer: TAL.Writer): TAL.Writer => {
    return {
        write: writer.write.bind(writer),
    }
}
