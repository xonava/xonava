---
"@xonava/core": minor
---

**Breaking:** a `fieldAccess.query` grant now lifts a mask or omit query denial only when it comes from an unconditional allow policy; grants from conditional allow policies are ignored, because queries are not evaluated per row and the grant exposed masked values. Move such grants to an unconditional policy.
