import { Deferred } from '@escapace/deferred'
import { interpret, stateMachine } from '@escapace/fsm'

enum MachineState {
  Cancelled,
  Cancelling,
  Fulfilled,
  Pending,
  Rejected,
}

enum MachineAction {
  Cancel,
  CancelComplete,
  Reject,
  Resolve,
  Setup,
}

interface MachineContext {
  deferred: Deferred<WithPromiseResult>
  onCancelCallbacks: Set<() => unknown>
}

/**
 * Result returned when the operation passed to {@link withPromise} fulfills.
 *
 * @typeParam T - Value produced by the operation.
 */
export interface WithPromiseFulfilledResult<T = unknown> {
  /**
   * Indicates that the operation fulfilled.
   */
  state: 'fulfilled'

  /**
   * Fulfilled value produced by the operation.
   */
  value: T
}

/**
 * Result returned when the operation passed to {@link withPromise} rejects.
 *
 * @remarks
 * The returned promise still fulfills. Rejections are represented as data so callers can branch on
 * `state` without using `try`/`catch`.
 */
export interface WithPromiseRejectedResult {
  /**
   * Indicates that the operation rejected.
   */
  state: 'rejected'

  /**
   * Rejection reason from the operation.
   */
  value: unknown
}

/**
 * Result returned when a {@link WithPromise} is cancelled before it fulfills or rejects.
 */
export interface WithPromiseCancelledResult {
  /**
   * Indicates that cancellation won the race with fulfillment or rejection.
   */
  state: 'cancelled'
}

/**
 * Settled result produced by a {@link WithPromise}.
 *
 * @remarks
 * Unlike a regular promise, {@link withPromise} always fulfills with one of these tagged result
 * objects. Use `state` to distinguish fulfillment, rejection, and cancellation.
 *
 * @typeParam T - Value produced when the operation fulfills.
 */
export type WithPromiseResult<T = unknown> =
  | WithPromiseCancelledResult
  | WithPromiseFulfilledResult<T>
  | WithPromiseRejectedResult

/**
 * Creates a promise state machine definition
 */
const promiseMachine = /*@__PURE__*/ stateMachine()
  .state(MachineState.Pending)
  .state(MachineState.Fulfilled)
  .state(MachineState.Rejected)
  .state(MachineState.Cancelling)
  .state(MachineState.Cancelled)
  .initial(MachineState.Pending)
  .action<MachineAction.Setup, () => unknown>(MachineAction.Setup)
  .action<MachineAction.Resolve, unknown>(MachineAction.Resolve)
  .action<MachineAction.Reject, unknown>(MachineAction.Reject)
  .action<MachineAction.Cancel>(MachineAction.Cancel)
  .action<MachineAction.CancelComplete>(MachineAction.CancelComplete)
  .context<MachineContext>(() => ({
    deferred: new Deferred<WithPromiseResult>(),
    onCancelCallbacks: new Set(),
  }))
  .transition(
    MachineState.Pending,
    [MachineAction.Setup, (context) => !context.deferred.isResolved()],
    MachineState.Pending,
    (context, action) => {
      context.onCancelCallbacks.add(action.payload)

      return context
    },
  )
  .transition(
    MachineState.Pending,
    [MachineAction.Resolve, (context) => !context.deferred.isResolved()],
    MachineState.Fulfilled,
    (context, action) => {
      context.deferred.resolve({ state: 'fulfilled', value: action.payload })
      context.onCancelCallbacks.clear()

      return context
    },
  )
  .transition(
    MachineState.Pending,
    [MachineAction.Reject, (context) => !context.deferred.isResolved()],
    MachineState.Rejected,
    (context, action) => {
      context.deferred.resolve({ state: 'rejected', value: action.payload })
      context.onCancelCallbacks.clear()

      return context
    },
  )
  .transition(
    MachineState.Pending,
    [MachineAction.Cancel, (context) => !context.deferred.isResolved()],
    MachineState.Cancelling,
    (context) => {
      context.deferred.resolve({
        state: 'cancelled',
      })

      return context
    },
  )
  .transition(
    MachineState.Cancelling,
    MachineAction.CancelComplete,
    MachineState.Cancelled,
    (context) => {
      context.onCancelCallbacks.clear()

      return context
    },
  )
  .done()

/**
 * Promise returned by {@link withPromise}.
 *
 * @remarks
 * This interface extends `Promise<WithPromiseResult<T>>` with synchronous state inspection and a
 * `cancel()` method. The promise never rejects. Fulfillment, rejection, and cancellation are all
 * reported through {@link WithPromiseResult}.
 *
 * @typeParam T - Value produced when the operation fulfills.
 */
export interface WithPromise<T> extends Promise<WithPromiseResult<T>> {
  /**
   * Current state of the operation.
   *
   * @remarks
   * The value starts as `pending` and then changes synchronously to `fulfilled`, `rejected`, or
   * `cancelled` as soon as that result becomes final.
   */
  state: 'cancelled' | 'fulfilled' | 'pending' | 'rejected'

  /**
   * Cancels the operation.
   *
   * @remarks
   * The first call settles the returned promise immediately as cancelled, then runs registered
   * cancellation callbacks sequentially. The promise returned by `cancel()` resolves after that
   * cleanup completes. Repeated calls are safe.
   *
   * @returns A promise that resolves when cancellation callbacks have finished running.
   */
  cancel: () => Promise<void>
}

const WITH_PROMISE_STATE = {
  [MachineState.Cancelled]: 'cancelled',
  [MachineState.Cancelling]: 'cancelled',
  [MachineState.Fulfilled]: 'fulfilled',
  [MachineState.Pending]: 'pending',
  [MachineState.Rejected]: 'rejected',
} as const

/**
 * Creates a cancellable promise that always fulfills with a {@link WithPromiseResult}.
 *
 * @remarks
 * The returned promise exposes synchronous state inspection through `state` and cancellation
 * through `cancel()`. When the operation fulfills, the promise resolves to
 * `{ state: 'fulfilled', value }`. When the operation rejects, the promise resolves to
 * `{ state: 'rejected', value }` instead of rejecting.
 *
 * The first call to `cancel()` settles the promise immediately as `{ state: 'cancelled' }`, then
 * runs registered cancellation callbacks sequentially. The promise returned by `cancel()` resolves
 * after that cleanup finishes. Errors thrown by cancellation callbacks are ignored so later
 * callbacks still run.
 *
 * The function accepts either `withPromise(promiseFactory)` or `withPromise(...args, promiseFactory)`.
 * Any leading arguments are passed to `promiseFactory` before the `onCancel` callback.
 *
 * @typeParam T - Value produced when the operation fulfills.
 * @typeParam U - Tuple of arguments forwarded to `promiseFactory` before `onCancel`.
 * @param arguments_ - Arguments passed to the promise factory, followed by the promise factory.
 * @returns A {@link WithPromise} that resolves to the operation result and exposes cancellation.
 */
// eslint-disable-next-line typescript/promise-function-async
export function withPromise<T = unknown, U extends unknown[] = []>(
  ...arguments_: [
    ...U,
    (...arguments_: [...U, (cancelCallback: () => unknown) => void]) => Promise<T>,
  ]
): WithPromise<T> {
  const service = interpret(promiseMachine)
  const length = arguments_.length
  const promiseFactory = arguments_[length - 1] as (
    ...arguments_: [...U, (cancelCallback: () => unknown) => void]
  ) => Promise<T>
  const arguments__ = arguments_.slice(0, -1) as U

  // Handle promise resolution/rejection externally
  void promiseFactory(...arguments__, (cancelCallback) => {
    // Add the callback to the state machine
    service.do(MachineAction.Setup, cancelCallback)
  })
    .then((value: unknown) => {
      service.do(MachineAction.Resolve, value)
    })
    .catch((error: unknown) => {
      service.do(MachineAction.Reject, error)
    })

  const { promise } = service.context.deferred

  const cancel = async () => {
    if (service.do(MachineAction.Cancel)) {
      // Execute all cancellation callbacks sequentially
      const cancelCallbacks = service.context.onCancelCallbacks

      for (const callback of cancelCallbacks) {
        try {
          await Promise.resolve(callback())
        } catch {
          // Ignore cancellation callback errors and continue with remaining callbacks
        }
      }

      // Signal that cancellation is complete
      service.do(MachineAction.CancelComplete)
    } else if (service.state === MachineState.Cancelling) {
      await promise
    }

    return
  }

  void Object.defineProperties(promise, {
    state: {
      get() {
        return WITH_PROMISE_STATE[service.state]
      },
    },
  })

  // Directly assign cancel method to the promise object
  ;(promise as WithPromise<T>).cancel = cancel

  return promise as WithPromise<T>
}
