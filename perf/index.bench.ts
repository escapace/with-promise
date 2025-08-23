/* eslint-disable typescript/require-await */
/**
 * Performance Benchmarks: withPromise vs Regular Promise
 *
 * Direct 1:1 comparisons of withPromise overhead vs regular Promise.
 * Results show the exact overhead impact across different scenarios.
 */

import { bench, describe } from 'vitest'
import { withPromise } from '../src/index'

// Helper function to create work simulation promises
async function createWorkPromise(durationMs: number): Promise<string> {
  return await new Promise<string>((resolve) => {
    setTimeout(() => resolve('work completed'), durationMs)
  })
}

// Helper function to create benchmark pairs for work durations
function createWorkBenchmarks(durationMs: number) {
  bench(`regular Promise + ${durationMs}ms work`, async () => {
    const result = await createWorkPromise(durationMs)
    void result
  })

  bench(`withPromise + ${durationMs}ms work`, async () => {
    const state = await withPromise(async () => await createWorkPromise(durationMs))
    if (state.state === 'fulfilled') {
      void state.value
    }
  })
}

describe('Promise Overhead Benchmarks', () => {
  describe('Pure Promise Overhead', () => {
    describe('Immediate Resolution', () => {
      bench('regular Promise (immediate)', async () => {
        const result = await Promise.resolve('result')
        void result
      })

      bench('withPromise (immediate)', async () => {
        const state = await withPromise(async () => 'result')
        if (state.state === 'fulfilled') {
          void state.value
        }
      })
    })

    describe('Async Resolution', () => {
      bench('regular Promise (async)', async () => {
        const result = await new Promise<string>((resolve) => {
          setImmediate(() => resolve('result'))
        })
        void result
      })

      bench('withPromise (async)', async () => {
        const state = await withPromise(
          async () =>
            await new Promise<string>((resolve) => {
              setImmediate(() => resolve('result'))
            }),
        )
        if (state.state === 'fulfilled') {
          void state.value
        }
      })
    })
  })

  describe('Real-World Work Scenarios', () => {
    describe('Short Duration Work', () => {
      describe('1ms Work', () => {
        createWorkBenchmarks(1)
      })

      describe('5ms Work', () => {
        createWorkBenchmarks(5)
      })

      describe('10ms Work', () => {
        createWorkBenchmarks(10)
      })
    })

    describe('Medium Duration Work', () => {
      describe('25ms Work', () => {
        createWorkBenchmarks(25)
      })

      describe('50ms Work', () => {
        createWorkBenchmarks(50)
      })
    })

    describe('Long Duration Work', () => {
      describe('100ms Work', () => {
        createWorkBenchmarks(100)
      })
    })
  })
})
