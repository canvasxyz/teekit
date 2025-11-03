# @teekit/kettle

@teekit/kettle is a simple workerd-based JS runtime for confidential
workers. It provides to JS dependencies required for @teekit/tunnel,
quote generation, and sqlite (via libsql/sqld, optionally encrypted).

## Usage

```
npm run build:worker
npm run start:launcher         # Start an orchestrated kettle VM using a file:/// url
npm run start:launcher:remote  # Start an orchestrated remote kettle VM, that fetches app.ts from Github Gists
```

You will need to set GITHUB_TOKEN to start a remote kettle VM.
Follow the instructions when you run `npm run start:launcher:remote`.

## API

If you would like to use your own launcher, **startWorker** will start
the quote generation service, sqld, and a single-process JS VM.

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
    dbPath: '/tmp/myapp.sqlite',
    quoteServicePort: await findFreePort(),
    sqldPort: await findFreePort(),
    workerPort: 8000,
})
```

## License

AGPL-V3 (C) 2025