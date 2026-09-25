import type * as declared from "test-assert-lite"
import type {TAL} from "test-assert-lite"
import {createAssert} from "./assert/assert.ts"
import {html} from "./reporter/html.ts"
import {spec} from "./reporter/spec.ts"
import {tap} from "./reporter/tap.ts"
import {bridgeFromFetch} from "./session/client.ts"
import {createSessions} from "./session/session.ts"
import {createHarnessState} from "./session/state.ts"
import {createRegistrar} from "./suite/registrar.ts"

// Binds everything the package exposes to one tree.
export const createTAL: typeof declared.createTAL = () => {
    const state = createHarnessState()
    const {assert, tca} = createAssert()
    const {session, stdout, stderr, schedule, end} = createSessions(state, tca)
    const registrar = createRegistrar(state, schedule)
    const reporter: TAL.Reporter = {spec, tap, html}

    // A suite that does not load is one failed test named after the file,
    // as node --test files it; the run goes on to the next.
    const load: TAL.SessionAPI["load"] = async file => {
        try {
            await import(file)
        } catch (error) {
            registrar.test(file.replace(/^[^?]*\//, ""), () => {
                throw error
            })
        }
    }
    return {
        assert,
        reporter,
        session: {session, load, end, stdout, stderr, bridge: bridgeFromFetch},
        test: registrar,
    }
}
