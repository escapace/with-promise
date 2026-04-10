import { interpret, stateMachine } from '@escapace/fsm'
import { remove } from 'coastal'
import { withPromise, type WithPromise, type WithPromiseResult } from './index'

export type WithPromisesEntries<T extends object> = {
  [K in keyof T]-?: [K, T[K]]
}[keyof T]

export type WithPromisesSubscription<T extends object> = (
  ...entries: WithPromisesEntries<{ [K in keyof T]: T[K] }>
) => void

export interface WithPromises<T extends object> {
  subscribe: (subscription: WithPromisesSubscription<T>) => () => void
  switch: (key: keyof T, force?: boolean) => void
}

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
const machine = stateMachine()
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
