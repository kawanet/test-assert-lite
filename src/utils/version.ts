// This package's version, for the run's report and the CLI's -v: one
// source, package.json, inlined by the build and read as is under Node.
import pkg from "../../package.json" with {type: "json"}

export const VERSION: string = pkg.version
