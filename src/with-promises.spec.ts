import { Deferred } from '@escapace/deferred'
import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import { withPromises, type WithPromises, type WithPromisesRecord } from './'

// eslint-disable-next-line typescript/no-empty-function
const noop = () => {}

// Test helper functions to reduce duplication
function createMockFactory<T>(deferred: Deferred<T>, cancelCallback?: () => void) {
  return vi
    .fn<(onCancel: (cancelCallback: () => unknown) => void) => Promise<T>>()
    .mockImplementation(async (onCancel: (cancelCallback: () => unknown) => void) => {
      onCancel(cancelCallback ?? vi.fn(noop))
      return await deferred.promise
    })
}

function createTestManager<T extends object>(factoryMap: WithPromisesRecord<T>) {
  const manager = withPromises<T>(factoryMap)
  const tracker = new StateTracker(manager)

  return {
    cleanup: () => tracker.destroy(),
    manager,
    tracker,
  }
}

async function executeAndResolve<T extends object>(
  manager: WithPromises<T>,
  key: unknown,
  deferred: Deferred<unknown>,
  value: unknown,
  force = false,
) {
  manager.switch(key as never, force)
  deferred.resolve(value)
  await vi.advanceTimersByTimeAsync(0)
}

function assertStateChange<T extends object, K extends keyof T = keyof T>(
  tracker: StateTracker<T>,
  expectedKey: K | undefined,
  expectedValue: T[K] | undefined,
  expectedCount: number,
) {
  assert.equal(tracker.key, expectedKey)
  assert.equal(tracker.value, expectedValue)
  assert.equal(tracker.changeCount, expectedCount)
}

function setupMultipleFactories<T>(count: number) {
  const deferreds: Array<Deferred<T>> = []
  const cancelCallbacks: Array<ReturnType<typeof vi.fn>> = []
  const factories: Array<ReturnType<typeof vi.fn>> = []

  for (let index = 0; index < count; index++) {
    const deferred = new Deferred<T>()
    const cancelCallback = vi.fn()
    const factory = createMockFactory(deferred, cancelCallback)

    deferreds.push(deferred)
    cancelCallbacks.push(cancelCallback)
    factories.push(factory)
  }

  return { cancelCallbacks, deferreds, factories }
}

function createSubscriptionTest<T extends object>(factoryMap: T) {
  const manager = withPromises(factoryMap)
  const subscriptionSpy = vi.fn()
  const unsubscribe = manager.subscribe(subscriptionSpy)

  return {
    manager,
    subscriptionSpy,
    unsubscribe: () => unsubscribe(),
  }
}

function createDynamicFactory<T>(
  deferreds: Array<Deferred<T>>,
  cancelCallbacks: Array<ReturnType<typeof vi.fn>>,
) {
  let callCount = 0
  return vi.fn().mockImplementation(async (onCancel: (cancelCallback: () => unknown) => void) => {
    const currentCall = callCount++
    // eslint-disable-next-line typescript/strict-boolean-expressions
    onCancel(cancelCallbacks[currentCall] || vi.fn(noop))
    return await deferreds[currentCall].promise
  })
}

// Helper class to track state changes via subscriptions
class StateTracker<T extends object> {
  private _history: Array<{ key: keyof T; value: T[keyof T] }> = []
  private _key: keyof T | undefined = undefined
  private readonly _unsubscribe: (() => void) | undefined = undefined
  private _value: T[keyof T] | undefined = undefined

  constructor(manager: WithPromises<T>) {
    this._unsubscribe = manager.subscribe((key, value) => {
      this._key = key
      this._value = value as T[keyof T]
      this._history.push({ key, value: value as T[keyof T] })
    })
  }

  get key(): keyof T | undefined {
    return this._key
  }

  get value(): T[keyof T] | undefined {
    return this._value
  }

  get history(): Array<{ key: keyof T; value: T[keyof T] }> {
    return [...this._history]
  }

  get changeCount(): number {
    return this._history.length
  }

  reset(): void {
    this._key = undefined
    this._value = undefined
    this._history = []
  }

  destroy(): void {
    this._unsubscribe?.()
  }
}

describe('withPromises', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores duplicate executions of the same key while executing', async () => {
    const deferred1 = new Deferred<string>()
    const cancelCallback1 = vi.fn()
    const promiseFactory = createMockFactory(deferred1, cancelCallback1)
    const { cleanup, manager, tracker } = createTestManager({ key1: promiseFactory })

    manager.switch('key1')
    assert.equal(promiseFactory.mock.calls.length, 1)

    manager.switch('key1')
    manager.switch('key1')

    assert.equal(promiseFactory.mock.calls.length, 1)

    await vi.advanceTimersByTimeAsync(0)

    assert.equal(cancelCallback1.mock.calls.length, 0)

    await executeAndResolve(manager, 'key1', deferred1, 'test-value')
    assertStateChange(tracker, 'key1', 'test-value', 1)

    cleanup()
  })

  for (const force of [true, false]) {
    it(`executes a promise for a key and notifies subscribers on resolution with force=${force}`, async () => {
      const deferred = new Deferred<string>()
      const cancelCallback = vi.fn()
      const promiseFactorySpy = createMockFactory(deferred, cancelCallback)
      const { cleanup, manager, tracker } = createTestManager({ key1: promiseFactorySpy })

      manager.switch('key1', force)

      assert.equal(promiseFactorySpy.mock.calls.length, 1)
      assertStateChange(tracker, undefined, undefined, 0)

      await executeAndResolve(manager, 'key1', deferred, 'test-value', force)

      assertStateChange(tracker, 'key1', 'test-value', 1)
      assert.deepEqual(tracker.history[0], { key: 'key1', value: 'test-value' })

      cleanup()
    })

    it(`handles promise rejection without notifying subscribers with force=${force}`, async () => {
      const deferred = new Deferred<string>()
      const cancelCallback = vi.fn()
      const promiseFactorySpy = createMockFactory(deferred, cancelCallback)
      const { cleanup, manager, tracker } = createTestManager({ key1: promiseFactorySpy })

      manager.switch('key1', force)

      deferred.reject(new Error('test error'))
      await vi.advanceTimersByTimeAsync(0)

      assertStateChange(tracker, undefined, undefined, 0)

      cleanup()
    })

    it(`executes multiple keys sequentially and updates state correctly with force=${force}`, async () => {
      const { deferreds, factories } = setupMultipleFactories<string>(2)
      const { cleanup, manager, tracker } = createTestManager({
        key1: factories[0],
        key2: factories[1],
      })

      await executeAndResolve(manager, 'key1', deferreds[0], 'value1', force)
      assertStateChange(tracker, 'key1', 'value1', 1)

      await executeAndResolve(manager, 'key2', deferreds[1], 'value2', force)
      assertStateChange(tracker, 'key2', 'value2', 2)
      assert.deepEqual(tracker.history, [
        { key: 'key1', value: 'value1' },
        { key: 'key2', value: 'value2' },
      ])

      cleanup()
    })

    it(`cancels previous promise when executing different key with force=${force}`, async () => {
      const { cancelCallbacks, deferreds, factories } = setupMultipleFactories<string>(2)
      const { cleanup, manager, tracker } = createTestManager({
        key1: factories[0],
        key2: factories[1],
      })

      manager.switch('key1', force)
      assert.equal(factories[0].mock.calls.length, 1)

      manager.switch('key2', force)
      assert.equal(factories[1].mock.calls.length, 1)

      await vi.advanceTimersByTimeAsync(0)

      assert.equal(cancelCallbacks[0].mock.calls.length, 1)
      assert.equal(cancelCallbacks[1].mock.calls.length, 0)

      await executeAndResolve(manager, 'key2', deferreds[1], 'value2')
      assertStateChange(tracker, 'key2', 'value2', 1)

      deferreds[0].resolve('value1')
      await vi.advanceTimersByTimeAsync(0)

      assertStateChange(tracker, 'key2', 'value2', 1)

      cleanup()
    })

    it(`cancels current execution when re-executing previous successful key with force=${force}`, async () => {
      const { cancelCallbacks, deferreds, factories } = setupMultipleFactories<string>(2)
      const { cleanup, manager, tracker } = createTestManager({
        key1: factories[0],
        key2: factories[1],
      })

      await executeAndResolve(manager, 'key1', deferreds[0], 'key1-value')
      assertStateChange(tracker, 'key1', 'key1-value', 1)
      assert.equal(factories[0].mock.calls.length, 1)

      manager.switch('key2')
      assert.equal(factories[1].mock.calls.length, 1)
      await vi.advanceTimersByTimeAsync(0)

      manager.switch('key1', force)

      assert.equal(factories[0].mock.calls.length, force ? 2 : 1)

      await vi.advanceTimersByTimeAsync(0)
      assert.equal(cancelCallbacks[1].mock.calls.length, 1)

      assertStateChange(tracker, 'key1', 'key1-value', force ? 2 : 1)

      deferreds[1].resolve('key2-value')
      await vi.advanceTimersByTimeAsync(0)

      assertStateChange(tracker, 'key1', 'key1-value', force ? 2 : 1)

      assert.deepEqual(
        tracker.history,
        force
          ? [
              { key: 'key1', value: 'key1-value' },
              { key: 'key1', value: 'key1-value' },
            ]
          : [{ key: 'key1', value: 'key1-value' }],
      )

      cleanup()
    })

    it(`same key is requested with force=${force}`, async () => {
      const { deferreds, factories } = setupMultipleFactories<string>(2)
      const { cleanup, manager, tracker } = createTestManager({
        key1: factories[0],
        key2: factories[1],
      })

      await executeAndResolve(manager, 'key1', deferreds[0], 'key1-value')
      assertStateChange(tracker, 'key1', 'key1-value', 1)
      assert.equal(factories[0].mock.calls.length, 1)

      manager.switch('key1', force)
      assert.equal(factories[0].mock.calls.length, force ? 2 : 1)

      await executeAndResolve(manager, 'key2', deferreds[1], 'key2-value')
      assertStateChange(tracker, 'key2', 'key2-value', 2)

      cleanup()
    })
  }

  it('should handle same-key execution guard conditions properly', async () => {
    const deferreds = [new Deferred<string>(), new Deferred<string>(), new Deferred<string>()]
    const cancelCallbacks = [vi.fn(), vi.fn(), vi.fn()]
    const promiseFactory = createDynamicFactory(deferreds, cancelCallbacks)
    const { cleanup, manager, tracker } = createTestManager({
      key1: promiseFactory,
      key2: promiseFactory,
    })

    await executeAndResolve(manager, 'key1', deferreds[0], 'first-value')
    assertStateChange(tracker, 'key1', 'first-value', 1)

    manager.switch('key1')
    assert.equal(promiseFactory.mock.calls.length, 1)

    manager.switch('key1', true)
    assert.equal(promiseFactory.mock.calls.length, 2)

    manager.switch('key2')
    assert.equal(promiseFactory.mock.calls.length, 3)

    deferreds[1].resolve('second-value')
    deferreds[2].resolve('third-value')
    await vi.advanceTimersByTimeAsync(0)

    cleanup()
  })

  it('should cancel first promise when same key executed with force=true', async () => {
    const deferreds = [new Deferred<string>(), new Deferred<string>()]
    const cancelCallbacks = [vi.fn(), vi.fn()]
    const promiseFactory = createDynamicFactory(deferreds, cancelCallbacks)
    const { cleanup, manager, tracker } = createTestManager({ key1: promiseFactory })

    manager.switch('key1')
    assert.equal(promiseFactory.mock.calls.length, 1)
    assert.equal(cancelCallbacks[0].mock.calls.length, 0)

    manager.switch('key1', true)
    assert.equal(promiseFactory.mock.calls.length, 2)

    await vi.advanceTimersByTimeAsync(0)

    assert.equal(cancelCallbacks[0].mock.calls.length, 1)
    assert.equal(cancelCallbacks[1].mock.calls.length, 0)

    deferreds[1].resolve('forced-result')
    await vi.advanceTimersByTimeAsync(0)

    assertStateChange(tracker, 'key1', 'forced-result', 1)

    deferreds[0].resolve('cancelled-result')
    await vi.advanceTimersByTimeAsync(0)

    assertStateChange(tracker, 'key1', 'forced-result', 1)

    cleanup()
  })

  it('throws on execution with non-existent key', () => {
    const records = {
      key1: vi.fn(),
    }

    const manager = withPromises(records)
    const tracker = new StateTracker(manager)

    // This will throw because records['nonexistent-key'] is undefined
    // and the implementation tries to call withPromise(undefined)
    assert.throws(() => {
      ;(manager.switch as (key: string) => void)('nonexistent-key')
    }, /promiseFactory is not a function/)

    // State should remain unchanged
    assert.equal(tracker.key, undefined)
    assert.equal(tracker.value, undefined)
    assert.equal(tracker.changeCount, 0)

    tracker.destroy()
  })

  it('should stop notifications after unsubscribe', async () => {
    const deferreds = [new Deferred<string>(), new Deferred<string>()]
    const factories = [createMockFactory(deferreds[0]), createMockFactory(deferreds[1])]
    const { manager, subscriptionSpy, unsubscribe } = createSubscriptionTest({
      key1: factories[0],
      key2: factories[1],
    })

    await executeAndResolve(manager, 'key1', deferreds[0], 'value1')
    assert.equal(subscriptionSpy.mock.calls.length, 1)

    unsubscribe()

    await executeAndResolve(manager, 'key2', deferreds[1], 'value2')
    assert.equal(subscriptionSpy.mock.calls.length, 1)
  })

  it(`fuzz`, { repeats: 100 }, async () => {
    let index = 0
    const cancelCallbacks = [vi.fn(), vi.fn()]

    const bool = () => Math.random() < 0.5

    const NUMBER = 200 + Math.floor(50 * Math.random())
    const DELAY = 1000

    const states: string[] = []

    function defer<T extends number | string>(ms = 0, value: T, fail: boolean): Promise<T> | T {
      const sync = bool()

      if (ms <= 0) {
        if (sync && fail) {
          throw new Error(`${value}`)
        }

        // "Sync" in the sense of an already-resolved Promise (microtask)
        return sync ? value : fail ? Promise.reject(new Error(`${value}`)) : Promise.resolve(value)
      }

      return new Promise<T>((resolve, reject) => {
        setTimeout(() => (fail ? reject(new Error(`${value}`)) : resolve(value)), ms)
      })
    }

    const createFuzzImplementation = (key: 'key1' | 'key2') =>
      vi.fn().mockImplementation(async (onCancel: (cancelCallback: () => unknown) => void) => {
        onCancel(cancelCallbacks[key === 'key1' ? 0 : 1])
        const value = `${key}-${index}`
        const fail = bool() && index < NUMBER * 0.9

        if (!fail) {
          states.push(value)
        }

        if (bool()) {
          onCancel(() => {
            throw new Error('error')
          })
        }

        onCancel(() => {
          const index_ = states.indexOf(value)
          if (index_ !== -1) {
            states.splice(index_, 1)
          }
        })

        return await defer(bool() ? 0 : Math.random() * DELAY, value, fail)
      })

    const { cleanup, manager, tracker } = createTestManager({
      key1: createFuzzImplementation('key1'),
      key2: createFuzzImplementation('key2'),
    })

    const executed: string[] = []

    while (index !== NUMBER) {
      index++
      const key = bool() ? 'key1' : 'key2'
      const force = bool()
      if (bool()) {
        executed.push(`${key}-${index}`)
        manager.switch(key, force)

        await vi.advanceTimersByTimeAsync(Math.random() * DELAY)
      }
    }

    await vi.advanceTimersByTimeAsync(DELAY * NUMBER * 1.15)

    const history = [...tracker.history]

    assert.deepEqual(
      states,
      history.map((value) => value.value),
    )

    assert(states.every((value) => executed.includes(value)))

    let previous: number | undefined
    for (const item of history) {
      const current = parseInt((item.value as string).slice(5))
      assert(previous === undefined || previous < current)
      previous = current
      assert((item.value as string).startsWith(`${item.key}`))
    }

    // eslint-disable-next-line typescript/no-non-null-assertion, typescript/strict-boolean-expressions
    const lastKey = history.at(-1)?.key!.startsWith('key1') ? 'key1' : 'key2'
    const otherKey = lastKey === 'key1' ? 'key2' : 'key1'

    await vi.advanceTimersByTimeAsync(DELAY * NUMBER * 1.15)

    assert.deepEqual(tracker.history, history)

    if (bool()) {
      manager.switch(lastKey, true)
      await vi.advanceTimersByTimeAsync(DELAY * 1.15)
      assert.deepEqual(tracker.history.at(-1), { key: lastKey, value: `${lastKey}-${NUMBER}` })
    } else {
      manager.switch(otherKey)
      await vi.advanceTimersByTimeAsync(DELAY * 1.15)
      assert.deepEqual(tracker.history.at(-1), { key: otherKey, value: `${otherKey}-${NUMBER}` })
    }

    cleanup()
  })
})
