---
"@xonava/testing": patch
---

The `vitest` peer dependency range is widened to `^4.1.7 || ^5.0.0`. The published contract suites now declare their sequential groups with `describe(name, { concurrent: false }, ...)`, which runs sequentially on both Vitest 4.1 and Vitest 5 (`describe.sequential` is no longer available in Vitest 5's types).
