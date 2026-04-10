import { interpret, stateMachine } from '@escapace/fsm'
import { remove } from 'coastal'
import { withPromise, type WithPromise, type WithPromiseResult } from './index'

/**
 * Tuple union that keeps a task key paired with the value type for that key.
 *
 * @remarks
 * For a record such as `{ a: string; b: number }`, this type becomes `['a', string] | ['b', number]`.
 * It is used by {@link WithPromisesSubscription} so the callback receives the value type that
 * matches the reported key.
 *
 * @typeParam T - Mapping from task keys to resolved value types.
 */
export type WithPromisesEntries<T extends object> = {
  [K in keyof T]-?: [K, T[K]]
}[keyof T]

/**
 * Subscription callback invoked when a keyed task finishes successfully.
 *
 * @remarks
 * The callback is called with `(key, value)` only for fulfilled tasks. Rejected and cancelled
 * tasks do not trigger notifications.
 *
 * @typeParam T - Mapping from task keys to resolved value types.
 */
export type WithPromisesSubscription<T extends object> = (
  ...entries: WithPromisesEntries<{ [K in keyof T]: T[K] }>
) => void

/**
 * Controller returned by {@link withPromises}.
 *
 * @remarks
 * The controller keeps at most one task running at a time. Subscribers are notified once for each
 * fulfilled task, in finish order. Rejected and cancelled tasks are ignored.
 *
 * @typeParam T - Mapping from task keys to resolved value types.
 */
export interface WithPromises<T extends object> {
  /**
   * Registers a callback for successful task results.
   *
   * @remarks
   * The callback receives `(key, value)` for each fulfilled task. The returned function removes the
   * subscription. Rejected and cancelled tasks never trigger notifications.
   *
   * @param subscription - Callback invoked after a task for a key fulfills.
   * @returns A function that removes the subscription.
   */
  subscribe: (subscription: WithPromisesSubscription<T>) => () => void

  /**
   * Switches the controller to a task key.
   *
   * @remarks
   * When `key` differs from the currently running key, the current task is cancelled and a new
   * task starts. When `key` already matches the currently running key, the call is a no-op unless
   * `force` is `true`. When the controller is idle and `key` matches the last key that fulfilled
   * successfully, the call is a no-op unless `force` is `true`. When a different key is running and
   * `key` matches that last successful key, the running task is cancelled and the controller returns
   * to idle without emitting a notification.
   *
   * @param key - Task key to start or make current.
   * @param force - When `true`, always starts a fresh task for `key`, even if that key is already
   * current.
   */
  switch: (key: keyof T, force?: boolean) => void
}

/**
 * Record of promise factories accepted by {@link withPromises}.
 *
 * @remarks
 * Each factory receives an `onCancel` callback used to register cleanup functions and returns the
 * promise for its key.
 *
 * @typeParam T - Mapping from task keys to the values produced by their promise factories.
 */
// eslint-disable-next-line typescript/no-explicit-any
export type WithPromisesRecord<T extends object = any> = {
  [K in keyof T]: (onCancel: (cancelCallback: () => unknown) => void) => Promise<T[K]>
}

// State definitions
enum WithPromisesState {
  Idle,
  InFlight,
}

enum WithPromisesAction {
  Switch,
  Commit,
}

type WithPromisesContextSubscription = (key: unknown, value: unknown) => void

// Context type
interface WithPromisesContext {
  lastKey: number | string | symbol | undefined

  inFlightKey: number | string | symbol | undefined
  inFlightPromiseCancel: WithPromise<unknown>['cancel'] | undefined
}

// Action payloads
interface WithPromisesSwitchPayload {
  force: boolean
  key: number | string | symbol
  promise: () => Pick<WithPromise<unknown>, 'cancel'>
}

type WithPromisesCommitPayload = {
  key: number | string | symbol
} & WithPromiseResult

// Create the state machine
const machine = /*@__PURE__*/ stateMachine()
  .state(WithPromisesState.Idle)
  .state(WithPromisesState.InFlight)
  .initial(WithPromisesState.Idle)
  .action<WithPromisesAction.Switch, WithPromisesSwitchPayload>(WithPromisesAction.Switch)
  .action<WithPromisesAction.Commit, WithPromisesCommitPayload>(WithPromisesAction.Commit)
  .context<WithPromisesContext>(() => ({
    lastKey: undefined,
    value: undefined,

    inFlightKey: undefined,
    inFlightPromiseCancel: undefined,
  }))

  /**
   * Implements "rollback" semantics: switching back to the last success cancels current work and
   * restores a stable Idle state.
   */
  .transition(
    WithPromisesState.InFlight,
    [
      WithPromisesAction.Switch,
      (context, action) => action.payload.key === context.lastKey && !action.payload.force,
    ],
    WithPromisesState.Idle,
    (context) => {
      void context.inFlightPromiseCancel?.()

      context.inFlightKey = undefined
      context.inFlightPromiseCancel = undefined

      return context
    },
  )

  /**
   * Start (or restart) a new InFlight task on Switch. Executed when a **Switch** should actually
   * start work—either because it is forced, or because the target key differs from the current
   * in-flight key (or from the last committed key when Idle).
   */
  .transition(
    [WithPromisesState.InFlight, WithPromisesState.Idle],
    [
      WithPromisesAction.Switch,
      (context, action) =>
        action.payload.force ||
        (action.source === WithPromisesState.Idle
          ? action.payload.key !== context.lastKey
          : action.payload.key !== context.inFlightKey),
    ],
    WithPromisesState.InFlight,
    (context, { payload }) => {
      void context.inFlightPromiseCancel?.()

      const nextPromise = payload.promise()
      context.inFlightKey = payload.key
      context.inFlightPromiseCancel = nextPromise.cancel

      return context
    },
  )

  /**
   * Finish the current InFlight task on Commit (Commit on success). Handles a **Commit** event for
   * the **current** in-flight key with an outcome of either fulfilled or rejected. Canceled
   * outcomes are ignored.
   */
  .transition(
    WithPromisesState.InFlight,
    [
      WithPromisesAction.Commit,
      (context, action) =>
        action.payload.key === context.inFlightKey &&
        /* stay in Executing when promise was cancelled */ action.payload.state !== 'cancelled',
    ],
    WithPromisesState.Idle,
    (context, { payload }) => {
      context.inFlightKey = undefined
      context.inFlightPromiseCancel = undefined

      if (payload.state === 'fulfilled') {
        context.lastKey = payload.key
      }

      return context
    },
  )
  .done()

/**
 * Creates a keyed async task controller with latest-wins cancellation and deduplication.
 *
 * @remarks
 * At most one task runs at a time. Switching to a different key cancels the current task and
 * starts the new one. Only the latest fulfilled task notifies subscribers. Rejected and cancelled
 * results are ignored, so the last successful key and value remain unchanged.
 *
 * With `force` set to `false`, switching to the same key while that key is already running is a
 * no-op, and switching to the last successful key while idle is also a no-op. Switching back to
 * the last successful key while a different key is running cancels the current task and returns the
 * controller to an idle state without notifying subscribers.
 *
 * @typeParam T - Mapping from task keys to the values produced by their promise factories.
 * @param records - Promise factories indexed by key. Each factory receives an `onCancel` callback
 * used to register cleanup functions and should return the promise for that key.
 * @returns A {@link WithPromises} controller for switching between keyed tasks and subscribing to
 * successful results.
 */
export const withPromises = <T extends object>(records: WithPromisesRecord<T>): WithPromises<T> => {
  const service = interpret(machine)
  const subscriptions: WithPromisesContextSubscription[] = []

  service.subscribe(({ action, state }) => {
    if (
      state === WithPromisesState.Idle &&
      action.type === WithPromisesAction.Commit &&
      action.payload.state === 'fulfilled'
    ) {
      const { key, value } = action.payload

      for (let index = 0; index < subscriptions.length; index++) {
        subscriptions[index](key, value)
      }
    }
  })

  return {
    subscribe: (subscription: WithPromisesContextSubscription) => {
      if (!subscriptions.includes(subscription)) {
        subscriptions.push(subscription)
      }

      return () => {
        remove(subscriptions, (value) => value === subscription)
      }
    },
    switch: (key: keyof T, force = false) => {
      const value = records[key]

      const promise = () => {
        const promise = withPromise(value)
        const { cancel } = promise

        void promise.then((value) => {
          service.do(WithPromisesAction.Commit, { ...value, key })
        })

        return { cancel }
      }

      service.do(WithPromisesAction.Switch, { force, key, promise })
    },
  } as unknown as WithPromises<T>
}
