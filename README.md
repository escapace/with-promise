# withPromise

withPromise turns regular Promises into cancellable ones.

- **Immediate response**: The Promise immediately settles as cancelled instead of waiting for cancellation to finish
- **Cleanup execution**: Any cleanup functions registered during Promise creation get executed
- **State wrapping**: Instead of returning the actual value, it returns an object describing the Promise state: `{ type: 'fulfilled', value: value }`, `{ type: 'rejected', value: error }`, or `{ type: 'cancelled' }`
- **Safe cancellation**: Multiple cancel calls work safely, cleanup functions run in order, and errors in cleanup don't break anything
- **Normal Promise behavior**: When not cancelled, it behaves exactly like a regular Promise but with the wrapped state format

## Performance Cost

Real applications performing network requests, file I/O, or computation experience **close to no performance impact** from withPromise since any work time completely masks the withPromise overhead. withPromise adds overhead to pure Promise operations (`Promise.resolve()` which runs 15x slower, `new Promise(resolve => setImmediate(resolve))` which 3x slower). withPromise performs optimally in operations such as network requests, file operations, or computations where the overhead becomes negligible compared to the work being performed.

## Installation

```bash
npm install @escapace/with-promise
```

## Quick Start

```typescript
import { withPromise } from '@escapace/with-promise'

// Cancellable HTTP request
const request = withPromise(async (onCancel) => {
  const controller = new AbortController()

  // Register abort callback for cancellation
  onCancel(() => controller.abort())

  // Make the request
  const response = await fetch('/api/data', {
    signal: controller.signal,
  })

  return await response.json()
})

// Cancel the request after 2 seconds
setTimeout(() => request.cancel(), 2000)

// Handle the result
const response = await request
if (response.type === 'cancelled') {
  console.log('Request was cancelled')
} else if (response.type === 'fulfilled') {
  console.log('Data:', response.value)
} else {
  console.log('Error:', response.value)
}
```

## API Reference

### `withPromise<T>(promiseFactory)`

Creates a cancellable promise.

**Parameters:**

- `promiseFactory`: `(onCancel: (callback: () => unknown) => void) => Promise<T>`
  - Function that creates the async operation
  - Receives `onCancel` callback to register cleanup functions

**Returns:** `WithPromise<T>`

- Extends `Promise<WithPromiseState<T>>` with a `cancel()` method

### Promise States

Promises settle with state objects:

```typescript
// Promise fulfilled successfully
{ type: 'fulfilled', value: T }

// Promise rejected with error
{ type: 'rejected', value: unknown }

// Promise cancelled
{ type: 'cancelled' }
```

### Cancel Method

```typescript
promise.cancel(): Promise<void>
```

- Immediately settles the promise as cancelled
- Executes all registered cancellation callbacks
- Returns a Promise that resolves when cleanup is complete
- Safe to call multiple times
