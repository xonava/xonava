---
"@xonava/adapters": patch
---

Job progress stores: a write now returns the row it wrote rather than a concurrent writer's later one (MySQL and D1), the PostgreSQL and D1 stores reject a first progress write that names a sequence other than 0 with a conflict as MySQL already did, and the MySQL store reads `percent` without losing precision.
