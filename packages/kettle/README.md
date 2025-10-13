# @teekit/kettle

## Installing sqld

sqld is the libsql server that exposes a SQLite database over the
Hrana HTTP protocol. The demo script and tests expect `sqld` to be
available on your PATH.

### macOS

```
brew tap libsql/sqld
brew install sqld
```

### Linux

If `brew` is not installed:
```
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
eval "$('/home/linuxbrew/.linuxbrew/bin/brew' shellenv)"
```

Then install `sqld`:
```
brew tap libsql/sqld
brew install sqld
```

## Demo

The demo launches `sqld` and `workerd`, generates a random bearer
token, and injects `DB_URL`/`DB_TOKEN` bindings so
`packages/kettle/server.ts` can access the database via
`@libsql/client-web`.

```
npm run build:worker
npm run demo
```

The demo auto-selects free ports for both `sqld` and `workerd`, waits for
`sqld` to be reachable, and prints these environment variables once ready:

```
WORKERD_PORT=3001
DB_URL=http://127.0.0.1:8088
DB_TOKEN=...
```

Try the DB endpoints (the demo already injects the bindings):

```
curl -X POST http://localhost:${WORKERD_PORT}/db/init
curl -X POST http://localhost:${WORKERD_PORT}/db/put \
  -H 'content-type: application/json' \
  -d '{"key":"foo","value":"bar"}'
curl http://localhost:${WORKERD_PORT}/db/get?key=foo
```

## Running sqld manually

You can run `sqld` yourself if you prefer:

```
mkdir -p data.sqld
sqld --http-listen-addr 127.0.0.1:8088 --db-path data.sqld/app.sqlite
```

If port `8088` is taken, substitute any free port, and set
`DB_URL` accordingly when configuring clients.

## Run tests

```
npm test
```

If you see errors about `sqld` not found, ensure it’s installed and
available on PATH (`which sqld`).

If you are running `sqld` manually, make sure `DB_URL` matches the
listening address.