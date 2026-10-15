# Attachments

## Scope and requirements

An attachment binds stable attachment identity, object reference, file metadata, lifecycle, and owning scoped application resource. Creating or resolving a reference MUST enforce resource authority and MUST NOT grant broader object-store access. Content type, non-negative size, checksum, display name, and timestamps MUST be validated and bounded where present. Object-provider metadata MUST be reconciled rather than blindly trusted from caller input.

Upload authorization and object commit are distinct from attaching the resulting reference to a resource. Signed upload/download MUST be short-lived and scope-bound. Deletion/reference lifecycle and orphan cleanup MUST be explicit; a reference mutation declared atomic with a resource MUST share its transaction or use a documented compensating protocol. Deleting one reference MUST NOT delete a shared object unless ownership/reference rules permit it.

## Conformance

Test scope isolation, hostile metadata, missing objects, checksum/size constraints, signed expiry, upload-finalization mismatch, shared references, lifecycle/orphan compensation, and authorization. Traceability: `@xonava/core/storage`; O1.
