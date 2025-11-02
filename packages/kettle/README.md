# @teekit/kettle

@teekit/kettle is a simple workerd-based JS runtime for confidential
workers. It provides to JS dependencies required for @teekit/tunnel,
quote generation, and sqlite (via libsql/sqld, optionally encrypted).

## Usage

**startWorker** will start the quote generation service, sqld service,
and a single-process JS worker VM.

It expects app.js, externals.js, and worker.js to be in the bundle
directory. To build the bundle, follow the steps provided below:

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
    dbPath: '/tmp/myapp.sqlite',
    quoteServicePort: await findFreePort(),
    sqldPort: await findFreePort(),
    workerPort: 8000,
})
```

## License

AGPL-V3 (C) 2025