// The session's own entry: opening it, loading the suites into it, and
// ending it, from the shared harness. No default: node has no such module.
import {sharedTAL} from "test-assert-lite"

export const {end, load, session, stdout, stderr, bridge} = sharedTAL.session
