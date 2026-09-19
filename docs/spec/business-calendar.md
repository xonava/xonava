# Business calendar

## Scope and requirements

A request contains non-empty calendar key and valid timezone identifier. The port determines whether an instant's local calendar date is a business day, returns the next business day strictly according to provider policy, and returns working windows for a requested half-open interval `[from,to)`.

The range endpoints MUST be valid and strictly increasing. Every returned window has valid start strictly before end, lies wholly within the requested range, is ordered by start, and does not overlap a previous window. Boundary-touching windows MAY be distinct. Returned timestamps MUST be defensively preserved. Working-time evaluation MUST handle daylight/timezone transitions and calendar exceptions deterministically.

## Conformance

Invalid requests/ranges/windows are validation failures; unknown calendar behavior and provider failure MUST be explicit. Test empty results, working/non-working days, exact boundaries, invalid/reversed ranges, unordered/overlapping/out-of-range windows, holidays, exceptions, next-day behavior, defensive timestamps, and timezone transitions. Traceability: `core/business-calendar`; H1.
