// Wrong arguments end in the usage text and exit code 2, after the reason
// when there is one to give. On its own, so that whatever checks a value
// can refuse it without reaching for the rest of the option reading.

export class UsageError extends Error {
}
