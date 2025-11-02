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

## Run tests

```
npm test
```

If you see errors about `sqld` not found, ensure it’s installed and
available on PATH (`which sqld`).

If you are running `sqld` manually, make sure `DB_URL` matches the
listening address.
