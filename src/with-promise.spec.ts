/* eslint-disable typescript/require-await */
/**
 * Promise Wrapper Test Suite
 *
 * This test suite verifies the behavior of the withPromise wrapper function
 * through its public API, focusing on observable behavior rather than internal state.
 *
 * Key features tested:
 * 1. **Promise Resolution/Rejection**: Verifies correct PromiseState objects are returned
 * 2. **Immediate Cancellation**: Tests that cancellation immediately resolves the promise with cancelled state
 * 3. **Cancellation Callbacks**: Verifies cancellation callbacks execute after immediate resolution
 * 4. **Interface Compliance**: Ensures WithPromise<T> behaves like a standard Promise with cancel()
 * 5. **Error Handling**: Verifies graceful handling of cancellation callback errors
 * 6. **Race Conditions**: Tests multiple cancel() calls and timing edge cases with immediate resolution
 */

import { afterEach, assert, beforeEach, describe, it, vi } from 'vitest'
import { withPromise } from '.'

// eslint-disable-next-line typescript/no-empty-function
const noop = (..._value: unknown[]) => {}

describe('Promise Wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Promise Resolution', () => {
    it('resolves with fulfilled state for successful promises', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        return 'success'
      })

      const result = await promiseWrapper
      assert.deepEqual(result, { state: 'fulfilled', value: 'success' })
    })

    it('resolves with rejected state for failed promises', async () => {
      const error = new Error('test error')
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        throw error
      })

      const result = await promiseWrapper
      assert.deepEqual(result, { state: 'rejected', value: error })
    })

    it('resolves with cancelled state immediately when cancelled', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'should not reach here'
      })

      // Cancel before completion - promise resolves immediately to cancelled state
      const cancelPromise = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.deepEqual(result, { state: 'cancelled' })

      // Cancel promise should also complete
      await cancelPromise
    })
  })

  describe('Cancellation Behavior', () => {
    it('executes cancellation callbacks after immediate promise resolution', async () => {
      const onCancelSpy = vi.fn()
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(onCancelSpy)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'completed'
      })

      const cancelPromise = promiseWrapper.cancel()

      // Promise resolves immediately to cancelled state
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // Cancellation callbacks execute asynchronously
      await cancelPromise
      assert.equal(onCancelSpy.mock.calls.length, 1)
    })

    it('immediately resolves to cancelled state for long-running operations', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        await new Promise((resolve) => setTimeout(resolve, 1000)) // Long operation
        return 'completed'
      })

      const cancelPromise = promiseWrapper.cancel()

      // Promise resolves immediately to cancelled state without waiting for operation
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      await cancelPromise
    })

    it('returns immediately when cancelling already resolved promises', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        return 'success'
      })

      // Wait for promise to resolve
      await promiseWrapper

      // Cancel after resolution - should return immediately
      await promiseWrapper.cancel()
      // No need to advance timers since it should be immediate
    })

    it('returns immediately when cancelling already rejected promises', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        throw new Error('failed')
      })

      // Wait for promise to reject
      await promiseWrapper

      // Cancel after rejection - should return immediately
      await promiseWrapper.cancel()
      // No need to advance timers since it should be immediate
    })
  })

  describe('Multiple Cancellation Calls', () => {
    it('handles multiple rapid cancel() calls with immediate resolution', async () => {
      const onCancelSpy = vi.fn()
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(onCancelSpy)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'completed'
      })

      // Fire multiple cancel() calls rapidly
      const cancelPromises = []
      for (let index = 0; index < 5; index++) {
        cancelPromises.push(promiseWrapper.cancel())
      }

      // All should return valid promises
      for (const promise of cancelPromises) {
        assert.ok(promise instanceof Promise, 'All cancel() calls should return Promises')
      }

      // Promise resolves immediately to cancelled state
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // All cancel promises should resolve
      await Promise.all(cancelPromises)

      // Callback should only be executed once
      assert.equal(
        onCancelSpy.mock.calls.length,
        1,
        'Callback should only execute once despite multiple cancel() calls',
      )
    })

    it('returns immediately for subsequent cancel() calls on cancelled promises', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'completed'
      })

      // First cancellation - promise resolves immediately
      const firstCancel = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')
      await firstCancel

      // Subsequent cancellations should return immediately
      await promiseWrapper.cancel()
    })
  })

  describe('Cancellation Callbacks', () => {
    it('executes multiple cancellation callbacks sequentially after immediate resolution', async () => {
      const executionOrder: number[] = []
      const callback1 = vi.fn(() => executionOrder.push(1))
      const callback2 = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        executionOrder.push(2)
      })
      const callback3 = vi.fn(() => executionOrder.push(3))

      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(callback1)
        onCancel(callback2)
        onCancel(callback3)
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return 'completed'
      })

      const cancelPromise = promiseWrapper.cancel()

      // Promise resolves immediately to cancelled state
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // Advance timers to complete async callback and wait for cancellation
      await vi.advanceTimersByTimeAsync(10)
      await cancelPromise

      // All callbacks should have been called
      assert.equal(callback1.mock.calls.length, 1)
      assert.equal(callback2.mock.calls.length, 1)
      assert.equal(callback3.mock.calls.length, 1)

      // Should maintain execution order (sequential despite async callback)
      assert.deepEqual(executionOrder, [1, 2, 3])
    })

    it('handles cancellation callback errors gracefully with immediate resolution', async () => {
      const successCallback = vi.fn()
      const errorCallback = vi.fn(() => {
        throw new Error('Callback error')
      })
      const finalCallback = vi.fn()

      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(successCallback)
        onCancel(errorCallback)
        onCancel(finalCallback)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'completed'
      })

      // Promise resolves immediately despite callback errors
      const cancelPromise = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // Should not throw despite callback error
      await cancelPromise

      // All callbacks should have been called despite the error
      assert.equal(successCallback.mock.calls.length, 1)
      assert.equal(errorCallback.mock.calls.length, 1)
      assert.equal(finalCallback.mock.calls.length, 1)
    })

    it('resolves immediately but waits for async cancellation callbacks in cancel promise', async () => {
      let callbackCompleted = false
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          callbackCompleted = true
        })
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return 'completed'
      })

      const cancelPromise = promiseWrapper.cancel()

      // Promise resolves immediately to cancelled state
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // Callback should not have completed yet
      assert.equal(callbackCompleted, false)

      // Advance timers to complete async callback
      await vi.advanceTimersByTimeAsync(50)
      await cancelPromise

      assert.equal(callbackCompleted, true)
    })

    it('prevents duplicate callback registration with immediate resolution', async () => {
      const callback = vi.fn()
      const promiseWrapper = withPromise(async (onCancel) => {
        // Register the same callback multiple times
        onCancel(callback)
        onCancel(callback)
        onCancel(callback)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'completed'
      })

      const cancelPromise = promiseWrapper.cancel()

      // Promise resolves immediately to cancelled state
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      await cancelPromise

      // Callback should only be executed once despite multiple registrations
      assert.equal(callback.mock.calls.length, 1)
    })
  })

  describe('Interface Compliance', () => {
    it('implements Promise interface correctly', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        return 'test'
      })

      // Should have Promise methods
      assert.equal(typeof promiseWrapper.then, 'function')
      assert.equal(typeof promiseWrapper.catch, 'function')
      assert.equal(typeof promiseWrapper.finally, 'function')

      // Should work with Promise methods
      const result = await promiseWrapper
      assert.deepEqual(result, { state: 'fulfilled', value: 'test' })
    })

    it('provides cancel method that returns Promise<void>', async () => {
      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(noop)
        await new Promise((resolve) => setTimeout(resolve, 50))
        return 'test'
      })

      // cancel should be a function
      assert.equal(typeof promiseWrapper.cancel, 'function')

      // cancel() should return a Promise
      const cancelResult = promiseWrapper.cancel()
      assert.ok(cancelResult instanceof Promise)

      // Complete the cancellation
      await vi.advanceTimersByTimeAsync(0)

      // Promise should resolve to undefined (Promise<void>)
      const resolvedValue = await cancelResult
      assert.equal(resolvedValue, undefined)
    })

    it('never throws synchronously from cancel() method', async () => {
      // Test various scenarios where cancel() should never throw
      const scenarios = [
        // Normal case
        withPromise(async (onCancel) => {
          onCancel(noop)
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 'test'
        }),
        // Callback that throws
        withPromise(async (onCancel) => {
          onCancel(() => {
            throw new Error('sync error')
          })
          return 'test'
        }),
        // Already resolved
        withPromise(async (onCancel) => {
          onCancel(noop)
          return 'immediate'
        }),
      ]

      // Wait for immediate resolution scenario
      await vi.advanceTimersByTimeAsync(0)

      for (const wrapper of scenarios) {
        assert.doesNotThrow(() => {
          // eslint-disable-next-line typescript/no-floating-promises
          wrapper.cancel()
        }, 'cancel() should never throw synchronously')
      }
    })
  })

  describe('AbortController Integration', () => {
    it('integrates with AbortController for request cancellation with immediate resolution', async () => {
      const abortHandlerSpy = vi.fn()

      /**
       * Mock fetch function that simulates network requests with AbortSignal support
       */
      async function mockFetch(
        url: string,
        options: { signal?: AbortSignal } = {},
      ): Promise<string> {
        return await new Promise((resolve, reject) => {
          const { signal } = options

          // Simulate network delay
          const timeoutId = setTimeout(() => {
            resolve(`Response from ${url}`)
          }, 100)

          // Handle abort signal
          const abortHandler = () => {
            abortHandlerSpy()
            clearTimeout(timeoutId)
            reject(new Error('AbortError: The operation was aborted'))
          }

          signal?.addEventListener('abort', abortHandler, { once: true })
        })
      }

      const promiseWrapper = withPromise(async (onCancel) => {
        const controller = new AbortController()
        onCancel(() => {
          if (!controller.signal.aborted) {
            controller.abort()
          }
        })

        return await mockFetch('https://api.example.com/users', {
          signal: controller.signal,
        })
      })

      // Cancel the request - promise resolves immediately
      const cancelPromise = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // Wait for cancellation callbacks to complete
      await cancelPromise

      // Verify abort was called
      assert.equal(abortHandlerSpy.mock.calls.length, 1)
    })
  })

  describe('Edge Cases and Race Conditions', () => {
    it('handles cancellation during promise factory execution with immediate resolution', async () => {
      let factoryStarted = false
      let factoryCompleted = false

      const promiseWrapper = withPromise(async (onCancel) => {
        factoryStarted = true
        onCancel(noop)

        // Simulate some async work in the factory
        await new Promise((resolve) => setTimeout(resolve, 50))

        factoryCompleted = true
        return 'completed'
      })

      // Let factory start
      await vi.advanceTimersByTimeAsync(0)
      assert.equal(factoryStarted, true)

      // Cancel before factory completes - promise resolves immediately
      const cancelPromise = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      await cancelPromise

      // Advance timers to let factory complete in background
      await vi.advanceTimersByTimeAsync(50)

      // Factory should have completed normally
      assert.equal(factoryCompleted, true)
    })

    it('maintains correct behavior with no cancellation callbacks and immediate resolution', async () => {
      const promiseWrapper = withPromise(async () => {
        // No onCancel calls
        await new Promise((resolve) => setTimeout(resolve, 50))
        return 'completed'
      })

      // Should not throw when cancelled without callbacks - resolves immediately
      const cancelPromise = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      await cancelPromise
    })

    it('handles rapid cancellation with async callback and immediate resolution', async () => {
      let cancellationCallbackCompleted = false

      const promiseWrapper = withPromise(async (onCancel) => {
        onCancel(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
          cancellationCallbackCompleted = true
        })
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return 'completed'
      })

      // Start cancellation - promise resolves immediately
      const cancelPromise1 = promiseWrapper.cancel()
      const result = await promiseWrapper
      assert.equal(result.state, 'cancelled')

      // Immediately try to cancel again
      const cancelPromise2 = promiseWrapper.cancel()

      // Advance timers to complete async callback
      await vi.advanceTimersByTimeAsync(100)

      // Both should complete successfully
      await Promise.all([cancelPromise1, cancelPromise2])

      // Async callback should have completed
      assert.equal(cancellationCallbackCompleted, true)
    })
  })
})
