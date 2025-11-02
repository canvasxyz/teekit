import type { ExecutionContext, TestFn } from "ava"
import whyIsNodeRunning from "why-is-node-running"

type LoggingContext = {
  __startTime?: number
}

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toISOString()

const formatDelta = (deltaMs: number) => `${deltaMs.toFixed(0)}ms`

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const REPORT_DELAY_MS = Number.parseInt(
  process.env.KETTLE_TEST_HANDLE_REPORT_DELAY_MS ?? "2000",
  10,
)

export const registerTestLogging = (test: TestFn<LoggingContext>) => {
  test.beforeEach((t) => {
    const now = Date.now()
    t.context.__startTime = now
    logEvent(t, now, "START")
  })

  test.afterEach.always((t) => {
    const now = Date.now()
    const start = t.context.__startTime ?? now
    const delta = now - start
    logEvent(t, now, "END", formatDelta(delta))
  })

  test.after.always(async () => {
    const scheduledAt = Date.now()
    logUtilityEvent(
      scheduledAt,
      `waiting ${formatDelta(REPORT_DELAY_MS)} before reporting handles`,
    )

    await delay(REPORT_DELAY_MS)

    logUtilityEvent(Date.now(), "running why-is-node-running")
    whyIsNodeRunning()
  })
}

const logEvent = (
  t: ExecutionContext<LoggingContext>,
  timestamp: number,
  phase: "START" | "END",
  extra?: string,
) => {
  const parts = [
    `[${formatTimestamp(timestamp)}]`,
    `[${phase}]`,
    `[${t.title}]`,
  ]

  if (extra) {
    parts.push(extra)
  }

  // eslint-disable-next-line no-console
  console.log(parts.join(" "))
}

const logUtilityEvent = (timestamp: number, message: string) => {
  // eslint-disable-next-line no-console
  console.log(`[${formatTimestamp(timestamp)}] [REPORT] ${message}`)
}
