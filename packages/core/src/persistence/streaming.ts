import type { QueryPlan } from "../query/queryPlan"

export interface StreamingReadOptions {
  readonly batchSize: number
  readonly signal: AbortSignal
  readonly deadline: Date
}

export interface BoundedStreamingReadOptions extends StreamingReadOptions { readonly maxItems: number }

export interface StreamingReadBatch<T> {
  readonly items: readonly T[]
  readonly batchNumber: number
}

/**
 * Optional bounded streaming contract. Cancellation and a finite deadline are
 * mandatory, preventing an adapter from exposing an unbounded durable cursor.
 */
export interface StreamingReadRepository<T> {
  stream(query: QueryPlan, options: StreamingReadOptions): AsyncIterable<StreamingReadBatch<T>>
}

export function assertStreamingReadOptions(options: StreamingReadOptions, now = new Date()): void {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) throw new TypeError("stream batchSize must be a positive safe integer")
  if (!(options.signal instanceof AbortSignal)) throw new TypeError("stream signal must be an AbortSignal")
  if (!(options.deadline instanceof Date) || !Number.isFinite(options.deadline.getTime())) throw new TypeError("stream deadline must be a valid Date")
  if (options.signal.aborted) throw options.signal.reason ?? new DOMException("stream aborted", "AbortError")
  if (options.deadline.getTime() <= now.getTime()) throw new DOMException("stream deadline exceeded", "TimeoutError")
}


/** Validates an adapter stream at every pull so limits hold across lazy execution. */
export async function* enforceBoundedStream<T>(source:AsyncIterable<StreamingReadBatch<T>>,options:BoundedStreamingReadOptions,now:()=>Date=()=>new Date()):AsyncIterable<StreamingReadBatch<T>>{
  assertStreamingReadOptions(options,now())
  if(!Number.isSafeInteger(options.maxItems)||options.maxItems<=0) throw new TypeError("stream maxItems must be a positive safe integer")
  let expectedBatch=0;let total=0
  for await(const batch of source){
    assertStreamingReadOptions(options,now())
    if(!Number.isSafeInteger(batch.batchNumber)||batch.batchNumber!==expectedBatch) throw new TypeError("stream batchNumber must be contiguous and zero-based")
    if(batch.items.length===0||batch.items.length>options.batchSize) throw new TypeError("stream adapter returned an empty or oversized batch")
    total+=batch.items.length;if(total>options.maxItems) throw new TypeError("stream exceeded maxItems")
    expectedBatch++;yield Object.freeze({...batch,items:Object.freeze([...batch.items])})
  }
  assertStreamingReadOptions(options,now())
}
