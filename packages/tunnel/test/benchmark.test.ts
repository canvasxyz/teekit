import test from "ava"
import {
  startHonoTunnelApp,
  startPlainHonoApp,
  stopPlainHonoApp,
  stopTunnel,
} from "./helpers/helpers.js"

interface BenchmarkStats {
  average: number
  median: number
  p90: number
  p99: number
  max: number
}

function calculateStats(timings: number[]): BenchmarkStats {
  const sorted = [...timings].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, val) => acc + val, 0)
  const average = sum / sorted.length

  const median = sorted[Math.floor(sorted.length / 2)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const p99 = sorted[Math.floor(sorted.length * 0.99)]
  const max = sorted[sorted.length - 1]

  return {
    average: Math.round(average * 100) / 100,
    median: Math.round(median * 100) / 100,
    p90: Math.round(p90 * 100) / 100,
    p99: Math.round(p99 * 100) / 100,
    max: Math.round(max * 100) / 100,
  }
}

function logStats(testName: string, stats: BenchmarkStats) {
  console.log(`\n${testName} - Performance Statistics:`)
  console.log(`  Average: ${stats.average}ms`)
  console.log(`  Median:  ${stats.median}ms`)
  console.log(`  90th %:  ${stats.p90}ms`)
  console.log(`  99th %:  ${stats.p99}ms`)
  console.log(`  Max:     ${stats.max}ms`)
}

// Request counts
const REQS_CONCURRENT = 100
const REQS = 50

test.serial(`benchmark: ${REQS_CONCURRENT} concurrent requests`, async (t) => {
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
  t.teardown(async () => {
    await stopTunnel(tunnelServer, tunnelClient)
  })
  const timings: number[] = []
  const concurrentCount = REQS_CONCURRENT

  const promises = Array.from({ length: concurrentCount }, async () => {
    const start = performance.now()
    const res = await tunnelClient.fetch("/hello")
    const end = performance.now()

    t.is(res.status, 200)
    t.is(await res.text(), "world")

    return end - start
  })

  const results = await Promise.all(promises)
  timings.push(...results)

  const stats = calculateStats(timings)
  logStats(`${REQS_CONCURRENT} concurrent requests`, stats)
})

test.serial(`benchmark: ${REQS} serial requests`, async (t) => {
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
  t.teardown(async () => {
    await stopTunnel(tunnelServer, tunnelClient)
  })
  const timings: number[] = []
  const serialCount = REQS

  for (let i = 0; i < serialCount; i++) {
    const start = performance.now()
    const res = await tunnelClient.fetch("/hello")
    const end = performance.now()

    t.is(res.status, 200)
    t.is(await res.text(), "world")

    timings.push(end - start)
  }

  const stats = calculateStats(timings)
  logStats(`${REQS} serial requests`, stats)
})

test.serial(`benchmark: ${REQS} requests with 1MB up/down`, async (t) => {
  const { tunnelServer, tunnelClient } = await startHonoTunnelApp()
  t.teardown(async () => {
    await stopTunnel(tunnelServer, tunnelClient)
  })
  const timings: number[] = []
  const uploadCount = REQS
  // Create 1MB payload
  const payload = "x".repeat(1024 * 1024)

  for (let i = 0; i < uploadCount; i++) {
    const start = performance.now()
    const res = await tunnelClient.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: payload,
    })
    const end = performance.now()

    t.is(res.status, 200)
    const json = await res.json()
    t.is(typeof json.body, "string")
    t.is((json.body as string).length, payload.length)

    timings.push(end - start)
  }

  const stats = calculateStats(timings)
  logStats(`${REQS} requests with 1MB up/down`, stats)
})

test.serial(`no tunnel: ${REQS_CONCURRENT} concurrent requests`, async (t) => {
  const { server, origin } = await startPlainHonoApp()
  t.teardown(() => stopPlainHonoApp(server))
  const timings: number[] = []
  const concurrentCount = REQS_CONCURRENT

  const promises = Array.from({ length: concurrentCount }, async () => {
    const start = performance.now()
    const res = await fetch(`${origin}/hello`)
    const end = performance.now()

    t.is(res.status, 200)
    t.is(await res.text(), "world")

    return end - start
  })

  const results = await Promise.all(promises)
  timings.push(...results)

  const stats = calculateStats(timings)
  logStats(`${REQS_CONCURRENT} concurrent requests (no tunnel)`, stats)
})

test.serial(`no tunnel: ${REQS} serial requests`, async (t) => {
  const { server, origin } = await startPlainHonoApp()
  t.teardown(() => stopPlainHonoApp(server))
  const timings: number[] = []
  const serialCount = REQS

  for (let i = 0; i < serialCount; i++) {
    const start = performance.now()
    const res = await fetch(`${origin}/hello`)
    const end = performance.now()

    t.is(res.status, 200)
    t.is(await res.text(), "world")

    timings.push(end - start)
  }

  const stats = calculateStats(timings)
  logStats(`${REQS} serial requests (no tunnel)`, stats)
})

test.serial(`no tunnel: ${REQS} requests with 1MB up/down`, async (t) => {
  const { server, origin } = await startPlainHonoApp()
  t.teardown(() => stopPlainHonoApp(server))
  const timings: number[] = []
  const uploadCount = REQS
  // Create 1MB payload
  const payload = "x".repeat(1024 * 1024)

  for (let i = 0; i < uploadCount; i++) {
    const start = performance.now()
    const res = await fetch(`${origin}/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: payload,
    })
    const end = performance.now()

    t.is(res.status, 200)
    const json = await res.json()
    t.is(typeof json.body, "string")
    t.is((json.body as string).length, payload.length)

    timings.push(end - start)
  }

  const stats = calculateStats(timings)
  logStats(`${REQS} requests with 1MB up/down (no tunnel)`, stats)
})
// (combined in echo test above)
