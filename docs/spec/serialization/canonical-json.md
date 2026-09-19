# Canonical JSON and digests

Framework 2.0 canonicalization identifier: `jcs-rfc8785-v1`. Digest identifier: `sha256-v1`. Values follow RFC 8785/JCS ordering and ECMAScript JSON number serialization. UTF-8 is mandatory; lone surrogates, non-finite numbers, unsafe integers, cycles, class instances and unencoded dates/binary values are rejected.

Resource ceilings for bytes, depth, nodes, object members, array items and strings are part of the format contract. Typed codecs encode timestamps as RFC 3339 UTC milliseconds and binary as canonical unpadded base64url.

Framework 2.0 accepts only its registered JCS-based durable formats. Applications must migrate pre-2.0 records before adopting this core; no legacy reader is shipped in the runtime package.
