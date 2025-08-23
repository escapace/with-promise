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

export interface WithPromiseFulfilledResult<T = unknown> {
  state: 'fulfilled'
  value: T
}

export interface WithPromiseRejectedResult {
  state: 'rejected'
  value: unknown
}

export interface WithPromiseCancelledResult {
  state: 'cancelled'
}

export type WithPromiseResult<T = unknown> =
  | WithPromiseCancelledResult
  | WithPromiseFulfilledResult<T>
  | WithPromiseRejectedResult

/**
 * Creates a promise state machine definition
 */
const promiseMachine = stateMachine()
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

export interface WithPromise<T> extends Promise<WithPromiseResult<T>> {
  cancel: () => Promise<void>
}

/**
 * Creates a promise wrapper with state machine tracking and cancellation support.
 * The state machine itself contains no async code - all promise handling is external.
 */
// eslint-disable-next-line typescript/promise-function-async
export function withPromise<T = unknown>(
  promiseFactory: (onCancel: (cancelCallback: () => unknown) => void) => Promise<T>,
): WithPromise<T> {
  const service = interpret(promiseMachine)

  // Handle promise resolution/rejection externally
  void promiseFactory((cancelCallback) => {
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

  // TODO: add a state property?
  // void Object.defineProperties(promise, {
  //   state: {
  //     get() {
  //       return service.context.deferred.
  //     }
  //   },
  // })

  // Directly assign cancel method to the promise object
  ;(promise as WithPromise<T>).cancel = cancel

  return promise as WithPromise<T>
}
