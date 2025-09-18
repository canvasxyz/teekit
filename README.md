# ra-https

This repository implements RA-HTTPS and RA-WSS, a set of protocols for
securely connecting to remotely attested Secure Enclaves and Trusted
Execution Environments.

## Demo

Node v22 is expected.

Run the client using `tsx`:

```
npm run dev
```

Run the server using Node.js:

```
npm run server
```

Run the typechecker:

```
npm run typecheck
```

## Tests

Run all tests:

```bash
npm test
```

### Simulated browser TDX verification

We added a test that simulates a browser environment (via jsdom) and runs the TDX v4 verification flow similar to `src/App.tsx`.

Run just the simulated browser test:

```bash
npx ava test/browser-tdx.test.ts
```

Notes:
- The test sets up a `jsdom` window/document and uses Node WebCrypto (do not override `global.crypto`).
- The TDX sample is taken from `test/sample/tdx-v4-tappd.hex` and converted to base64.

## Deploying

TBD
