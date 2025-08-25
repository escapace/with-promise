# @escapace/with-promise

This library provides two complementary utilities for managing async operations:

- **withPromise**: Turns regular Promises into cancellable ones
- **withPromises**: Async task controller implementing latest-wins semantics with automatic cancellation and deduplication

### Installation

```bash
pnpm install @escapace/with-promise
```

# withPromise

withPromise turns regular Promises into cancellable ones.

- **Immediate response**: The Promise immediately settles as cancelled instead of waiting for the cancellation to finish
- **Cleanup execution**: Any cleanup functions registered during Promise creation get executed
- **Wrapping**: Instead of returning the actual value, it returns an object describing the Promise state
- **Safe cancellation**: Multiple cancel calls work safely, cleanup functions run in order, and errors in cleanup don't break anything
- **Normal Promise behavior**: When not cancelled, it behaves exactly like a regular Promise but with the wrapped result format

## Performance Cost

Applications that perform network requests, file I/O, or computation experience **close to no performance impact** from withPromise, as any work time completely masks the withPromise overhead. withPromise adds overhead to pure Promise operations (`Promise.resolve()` is 15x faster, `new Promise(resolve => setImmediate(resolve))` is 3x faster). withPromise performs optimally in operations such as network requests, file operations, or computations where the overhead becomes negligible compared to the work being performed.

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

// Check state during execution
console.log('Status:', request.state) // 'pending'

// Handle the result
const response = await request
if (response.state === 'cancelled') {
  console.log('Request was cancelled')
} else if (response.state === 'fulfilled') {
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

- Extends `Promise<WithPromiseResult<T>>` with a `cancel()` method and `state` property

### Promise Result

Promises settle with a result object:

```typescript
// Promise fulfilled successfully
{ state: 'fulfilled', value: T }

// Promise rejected with error
{ state: 'rejected', value: unknown }

// Promise cancelled
{ state: 'cancelled' }
```

### Cancel Method

```typescript
promise.cancel(): Promise<void>
```

- Immediately settles the promise as cancelled
- Executes all registered cancellation callbacks
- Returns a Promise that resolves when cleanup is complete
- Safe to call multiple times

### State Property

```typescript
promise.state: 'pending' | 'fulfilled' | 'rejected' | 'cancelled'
```

- Returns the current state of the promise
- Updates synchronously when state changes
- Useful for conditional logic and debugging

# withPromises

Async task controller implementing latest-wins semantics with automatic cancellation and deduplication. At most one promise runs at any time.

- **Single in-flight**: There is never more than one running task; a switch cancels the previous in-flight promise exactly once
- **Latest wins for commits**: Only the current promise can commit; if you switch from A to B before A finishes, A is canceled and only B can subsequently commit; late results from A are ignored
- **Same-key deduplication**: Switching to the same key in two scenarios has no effect when `force: false` - while idle (switching to last committed key) or while in-flight (switching to currently running key)
- **Force**: `switch(key, true)` always starts a fresh promise for the key, canceling the current one even if it's already running the same key
- **Success-only notifications**: Subscribers are called exactly once per successful commit, never on reject or cancel; errors don't change the last good result
- **In-order emissions**: Notifications appear in the order successful tasks finish, never out of order or duplicated
- **Rollback**: When a different key is in-flight and you switch back to the last committed key with `force: false`, the in-flight promise is canceled and the machine returns to idle with the previous value; no notification fires since nothing new succeeded

## Quick Start

```typescript
import { withPromises } from '@escapace/with-promise'

// Define async operations for different tabs
const tabs = {
  overview: async (onCancel) => {
    const controller = new AbortController()
    onCancel(() => controller.abort())

    const response = await fetch('/api/dashboard/overview', {
      signal: controller.signal,
    })
    return await response.json()
  },
  analytics: async (onCancel) => {
    const controller = new AbortController()
    onCancel(() => controller.abort())

    const response = await fetch('/api/dashboard/analytics', {
      signal: controller.signal,
    })
    return await response.json()
  },
  settings: async (onCancel) => {
    const controller = new AbortController()
    onCancel(() => controller.abort())

    const response = await fetch('/api/dashboard/settings', {
      signal: controller.signal,
    })
    return await response.json()
  },
}

const dashboard = withPromises(tabs)

// Subscribe to successful tab loads
const unsubscribe = dashboard.subscribe((tab, data) => {
  console.log(`Loaded ${tab} tab:`, data)
})

// Switch between tabs - only latest request will complete
dashboard.switch('overview') // Starts loading overview
dashboard.switch('analytics') // Cancels overview, starts loading analytics
dashboard.switch('settings') // Cancels analytics, starts loading settings

// Force refresh current tab
dashboard.switch('settings', true)
```

## API Reference

### `withPromises<T>(records)`

Creates a promise manager for keyed async operations.

**Parameters:**

- `records`: `WithPromisesRecord<T>`
  - Object mapping keys to promise factory functions
  - Each factory receives `onCancel` callback for cleanup registration
  - Type: `{ [K in keyof T]: (onCancel: (callback: () => unknown) => void) => Promise<T[K]> }`

**Returns:** `WithPromises<T>`

### WithPromises Interface

```typescript
interface WithPromises<T extends object> {
  subscribe: (subscription: WithPromisesSubscription<T>) => () => void
  switch: (key: keyof T, force?: boolean) => void
}
```

### Subscribe Method

```typescript
subscribe(callback: (key: keyof T, value: T[keyof T]) => void): () => void
```

- Registers a callback for successful promise completions
- Called with `(key, value)` when a promise fulfills
- Returns unsubscribe function
- Only successful operations trigger notifications (errors and cancellations do not)

### Switch Method

```typescript
switch(key: keyof T, force?: boolean): void
```

- **Different key or forced**: Cancels current promise (if any) and starts the new one
- **Same key already in-flight with `force: false`**: No-op (deduplication)
- **Same key as last committed while idle with `force: false`**: No-op (deduplication)
- **Rollback case**: Switching back to last committed key while different key is in-flight cancels and returns to idle
- **Force restart**: `force: true` always restarts, canceling current work even for the same key
