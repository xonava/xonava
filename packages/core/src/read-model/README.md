# Read-model execution

`executeReadModel` applies one read-wide deadline. Callers may provide an absolute `deadline`, a bounded `timeoutMs`, or both (the earlier wins). If neither is provided, Core uses `DEFAULT_READ_MODEL_TIMEOUT_MS`; all executions are capped by `MAX_READ_MODEL_TIMEOUT_MS`. The effective deadline, clock, and one shared child `AbortSignal` are passed to every source executor.

Caller cancellation and deadline expiry always terminate the whole read, regardless of the partial-source failure policy. Ordinary provider rejection still follows that policy. Core removes its parent listener and timer when execution settles and observes providers that settle late, so they cannot cause unhandled rejections. JavaScript cannot forcibly stop an executor that ignores its signal; after termination Core stops waiting for it and does not process its eventual result.

Definitions are capped by the exported source, join, source-row, and output-row ceilings. Join execution builds a right-side index and also enforces `MAX_READ_MODEL_INDEXED_ROWS`. Join keys preserve strict-equality behavior: nullish and `NaN` keys do not match, while object keys match by identity.
