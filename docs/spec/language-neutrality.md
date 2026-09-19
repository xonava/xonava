# Language neutrality

The specification is independent of TypeScript. Implementations in Java, Go, Rust, C#, Python, PHP, or another language MAY use different API shapes but MUST preserve equivalent observable semantics.

Example: cache absence MUST be distinguishable from failure. A TypeScript implementation may use an optional asynchronous result, Java an optional value, Go a value/found/error tuple, and Rust a result containing an optional value. Syntax differs; the required distinction does not.

Terms such as asynchronous operation, absence, cancellation signal, binary payload, structured error, stream, timestamp, contract, and capability are normative concepts. Language-specific classes and containers are profiles only.
