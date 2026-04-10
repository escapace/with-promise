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

# API

## function withPromise [↗](src/with-promise.ts#L224-L285 'withPromise')

Creates a cancellable promise that always fulfills with a [WithPromiseResult](#type-withpromiseresult-).

```typescript
export declare function withPromise<T = unknown, U extends unknown[] = []>(
  ...arguments_: [
    ...U,
    (...arguments_: [...U, (cancelCallback: () => unknown) => void]) => Promise<T>,
  ]
): WithPromise<T>
```

### Type Parameters

| Parameter | Description                                                         |
| --------- | ------------------------------------------------------------------- |
| `T`       | Value produced when the operation fulfills.                         |
| `U`       | Tuple of arguments forwarded to `promiseFactory` before `onCancel`. |

### Parameters

| Parameter    | Type                                                                                                               | Description                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `arguments_` | <pre>\[<br> ...U,<br> (...arguments\_: \[...U, (cancelCallback: () => unknown) => void]) => Promise\<T><br>]</pre> | Arguments passed to the promise factory, followed by the promise factory. |

### Returns

A [WithPromise](#interface-withpromise-) that resolves to the operation result and exposes cancellation.

### Remarks

The returned promise exposes synchronous state inspection through `state` and cancellation through `cancel()`. When the operation fulfills, the promise resolves to `{ state: 'fulfilled', value }`. When the operation rejects, the promise resolves to `{ state: 'rejected', value }` instead of rejecting.

The first call to `cancel()` settles the promise immediately as `{ state: 'cancelled' }`, then runs registered cancellation callbacks sequentially. The promise returned by `cancel()` resolves after that cleanup finishes. Errors thrown by cancellation callbacks are ignored so later callbacks still run.

The function accepts either `withPromise(promiseFactory)` or `withPromise(...args, promiseFactory)`. Any leading arguments are passed to `promiseFactory` before the `onCancel` callback.

## function withPromises [↗](src/with-promises.ts#L227-L272 'withPromises')

Creates a keyed async task controller with latest-wins cancellation and deduplication.

```typescript
withPromises: <T extends object>(records: WithPromisesRecord<T>) => WithPromises<T>
```

### Type Parameters

| Parameter | Description                                                               |
| --------- | ------------------------------------------------------------------------- |
| `T`       | Mapping from task keys to the values produced by their promise factories. |

### Parameters

| Parameter | Type                                                                                     | Description                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records` | <pre>[WithPromisesRecord](#type-withpromisesrecord- 'type WithPromisesRecord')\<T></pre> | Promise factories indexed by key. Each factory receives an `onCancel` callback used to register cleanup functions and should return the promise for that key. |

### Returns

A [WithPromises](#interface-withpromises-) controller for switching between keyed tasks and subscribing to successful results.

### Remarks

At most one task runs at a time. Switching to a different key cancels the current task and starts the new one. Only the latest fulfilled task notifies subscribers. Rejected and cancelled results are ignored, so the last successful key and value remain unchanged.

With `force` set to `false`, switching to the same key while that key is already running is a no-op, and switching to the last successful key while idle is also a no-op. Switching back to the last successful key while a different key is running cancels the current task and returns the controller to an idle state without notifying subscribers.

## interface WithPromise [↗](src/with-promise.ts#L170-L191 'WithPromise')

Promise returned by [withPromise](#function-withpromise-).

```typescript
export interface WithPromise<T> extends Promise<WithPromiseResult<T>>
```

### Type Parameters

| Parameter | Description                                 |
| --------- | ------------------------------------------- |
| `T`       | Value produced when the operation fulfills. |

### Remarks

This interface extends `Promise<WithPromiseResult<T>>` with synchronous state inspection and a `cancel()` method. The promise never rejects. Fulfillment, rejection, and cancellation are all reported through [WithPromiseResult](#type-withpromiseresult-).

### WithPromise.cancel

Cancels the operation.

```typescript
cancel: () => Promise<void>
```

#### Remarks

The first call settles the returned promise immediately as cancelled, then runs registered cancellation callbacks sequentially. The promise returned by `cancel()` resolves after that cleanup completes. Repeated calls are safe.

### WithPromise.state

Current state of the operation.

```typescript
state: 'cancelled' | 'fulfilled' | 'pending' | 'rejected'
```

#### Remarks

The value starts as `pending` and then changes synchronously to `fulfilled`, `rejected`, or `cancelled` as soon as that result becomes final.

## interface WithPromiseCancelledResult [↗](src/with-promise.ts#L64-L69 'WithPromiseCancelledResult')

Result returned when a [WithPromise](#interface-withpromise-) is cancelled before it fulfills or rejects.

```typescript
export interface WithPromiseCancelledResult
```

### WithPromiseCancelledResult.state

Indicates that cancellation won the race with fulfillment or rejection.

```typescript
state: 'cancelled'
```

## interface WithPromiseFulfilledResult [↗](src/with-promise.ts#L30-L40 'WithPromiseFulfilledResult')

Result returned when the operation passed to [withPromise](#function-withpromise-) fulfills.

```typescript
export interface WithPromiseFulfilledResult<T = unknown>
```

### Type Parameters

| Parameter | Description                      |
| --------- | -------------------------------- |
| `T`       | Value produced by the operation. |

### WithPromiseFulfilledResult.state

Indicates that the operation fulfilled.

```typescript
state: 'fulfilled'
```

### WithPromiseFulfilledResult.value

Fulfilled value produced by the operation.

```typescript
value: T
```

## interface WithPromiseRejectedResult [↗](src/with-promise.ts#L49-L59 'WithPromiseRejectedResult')

Result returned when the operation passed to [withPromise](#function-withpromise-) rejects.

```typescript
export interface WithPromiseRejectedResult
```

### Remarks

The returned promise still fulfills. Rejections are represented as data so callers can branch on `state` without using `try`/`catch`.

### WithPromiseRejectedResult.state

Indicates that the operation rejected.

```typescript
state: 'rejected'
```

### WithPromiseRejectedResult.value

Rejection reason from the operation.

```typescript
value: unknown
```

## interface WithPromises [↗](src/with-promises.ts#L41-L70 'WithPromises')

Controller returned by [withPromises](#function-withpromises-).

```typescript
export interface WithPromises<T extends object>
```

### Type Parameters

| Parameter | Description                                     |
| --------- | ----------------------------------------------- |
| `T`       | Mapping from task keys to resolved value types. |

### Remarks

The controller keeps at most one task running at a time. Subscribers are notified once for each fulfilled task, in finish order. Rejected and cancelled tasks are ignored.

### WithPromises.subscribe

Registers a callback for successful task results.

```typescript
subscribe: (subscription: WithPromisesSubscription<T>) => () => void;
```

#### Remarks

The callback receives `(key, value)` for each fulfilled task. The returned function removes the subscription. Rejected and cancelled tasks never trigger notifications.

### WithPromises.switch

Switches the controller to a task key.

```typescript
switch: (key: keyof T, force?: boolean) => void;
```

#### Remarks

When `key` differs from the currently running key, the current task is cancelled and a new task starts. When `key` already matches the currently running key, the call is a no-op unless `force` is `true`. When the controller is idle and `key` matches the last key that fulfilled successfully, the call is a no-op unless `force` is `true`. When a different key is running and `key` matches that last successful key, the running task is cancelled and the controller returns to idle without emitting a notification.

## type WithPromiseResult [↗](src/with-promise.ts#L80-L83 'WithPromiseResult')

Settled result produced by a [WithPromise](#interface-withpromise-).

```typescript
export type WithPromiseResult<T = unknown> =
  | WithPromiseCancelledResult
  | WithPromiseFulfilledResult<T>
  | WithPromiseRejectedResult
```

### Type Parameters

| Parameter | Description                                 |
| --------- | ------------------------------------------- |
| `T`       | Value produced when the operation fulfills. |

### Remarks

Unlike a regular promise, [withPromise](#function-withpromise-) always fulfills with one of these tagged result objects. Use `state` to distinguish fulfillment, rejection, and cancellation.

## type WithPromisesEntries [↗](src/with-promises.ts#L15-L17 'WithPromisesEntries')

Tuple union that keeps a task key paired with the value type for that key.

```typescript
export type WithPromisesEntries<T extends object> = {
  [K in keyof T]-?: [K, T[K]]
}[keyof T]
```

### Type Parameters

| Parameter | Description                                     |
| --------- | ----------------------------------------------- |
| `T`       | Mapping from task keys to resolved value types. |

### Remarks

For a record such as `{ a: string; b: number }`, this type becomes `['a', string] | ['b', number]`. It is used by [WithPromisesSubscription](#type-withpromisessubscription-) so the callback receives the value type that matches the reported key.

## type WithPromisesRecord [↗](src/with-promises.ts#L82-L84 'WithPromisesRecord')

Record of promise factories accepted by [withPromises](#function-withpromises-).

```typescript
export type WithPromisesRecord<T extends object = any> = {
  [K in keyof T]: (onCancel: (cancelCallback: () => unknown) => void) => Promise<T[K]>
}
```

### Type Parameters

| Parameter | Description                                                               |
| --------- | ------------------------------------------------------------------------- |
| `T`       | Mapping from task keys to the values produced by their promise factories. |

### Remarks

Each factory receives an `onCancel` callback used to register cleanup functions and returns the promise for its key.

## type WithPromisesSubscription [↗](src/with-promises.ts#L28-L30 'WithPromisesSubscription')

Subscription callback invoked when a keyed task finishes successfully.

```typescript
export type WithPromisesSubscription<T extends object> = (
  ...entries: WithPromisesEntries<{
    [K in keyof T]: T[K]
  }>
) => void
```

### Type Parameters

| Parameter | Description                                     |
| --------- | ----------------------------------------------- |
| `T`       | Mapping from task keys to resolved value types. |

### Remarks

The callback is called with `(key, value)` only for fulfilled tasks. Rejected and cancelled tasks do not trigger notifications.
