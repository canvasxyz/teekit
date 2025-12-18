# @teekit/kettle

@teekit/kettle is a simple workerd-based JS runtime for confidential
workers. It provides JS dependencies required for @teekit/tunnel,
quote generation, and SQLite storage (via Durable Objects SQL API).

The kettle now uses workerd's built-in Durable Objects SQLite storage
instead of external SQLCipher:

- Created `services/worker/do-db.ts` - DO SQL adapter implementing SqliteClient interface
- Modified `services/worker/db.ts` - Added DO storage detection in getDb()
- Modified `services/worker/worker.ts` - Exposed ctx.storage to app via env
- Modified `services/startWorker.ts` - Uses DO SQLite with localDisk storage
- Updated workerd capnp config to use `enableSql = true` and `localDisk` storage
  
## Usage

```
npm run build:worker            # Builds dist from app.ts (default)
npm run build:worker -- app.ts  # You can pass a relative path
npm run start:launcher         # Start an orchestrated kettle VM using a file:/// url
npm run start:launcher:remote  # Start an orchestrated remote kettle VM, that fetches app.ts from Github Gists
npm run start:worker -- app.ts # Directly run local worker from a specific app path
```

Both `buildWorker` and `startWorker` CLIs accept an optional relative path to your `app.ts`. If omitted, they default to `app.ts` at the package root.

You will need to set GITHUB_TOKEN to start a remote kettle VM.
Follow the instructions when you run `npm run start:launcher:remote`.

## API

If you would like to use your own launcher, **startWorker** will start
the quote generation service and a single-process JS VM with Durable Objects SQLite storage.

The command expects app.js, externals.js, and worker.js to be in the
bundle directory. To build the bundle, follow these steps:

```ts
import { startWorker, findFreePort, buildKettleApp, buildKettleExternals } from "@teekit/kettle"

await buildKettleApp({
    source: '/home/app.ts',
    targetDir: '/home/build'
})
await buildKettleExternals({
    targetDir: '/home/build'
})

const { stop } = await startWorker({
    bundleDir: '/home/build',
    quoteServicePort: await findFreePort(),
    workerPort: 8000,
})
```

## License

AGPL-V3 (C) 2025
