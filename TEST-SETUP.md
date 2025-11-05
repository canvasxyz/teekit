# Test Setup Documentation

This document describes the steps needed to run tests for this repository, including the automatic installation of Homebrew and sqld.

## Prerequisites

- **Node.js**: Version 22.0.0 or higher
- **npm**: Version 10.9.0 or higher
- **Operating System**: Linux or macOS (for automatic Homebrew/sqld installation)

## Quick Start

1. **Install npm dependencies:**
   ```bash
   npm install
   ```

2. **Run tests:**
   ```bash
   npm test
   ```

The test script will automatically:
- Install Homebrew (if not already installed)
- Install sqld via Homebrew (if not already installed)
- Build all required packages
- Run tests across all workspaces

## Automatic Installation Process

### Homebrew Installation

The test setup script (`scripts/ensure-sqld.js`) automatically installs Homebrew if it's not already present:

- **On Linux**: Installs Linuxbrew to `/home/linuxbrew/.linuxbrew`
- **On macOS**: Installs Homebrew to `/opt/homebrew` (Apple Silicon) or `/usr/local/bin` (Intel)

The installation runs non-interactively with `NONINTERACTIVE=1` and configures the shell environment automatically.

### sqld Installation

After Homebrew is installed, the script:
1. Taps the `libsql/sqld` Homebrew repository
2. Installs `sqld` via `brew install sqld`
3. Verifies the installation by checking for the `sqld` binary

**sqld** is required by the `@teekit/kettle` package tests, which use it as an embedded database server.

**Verified Installation:**
- Homebrew version: 4.6.20
- sqld version: 0.24.31
- Installation location (Linux): `/home/linuxbrew/.linuxbrew/bin/sqld`
- Installation location (macOS Apple Silicon): `/opt/homebrew/bin/sqld`
- Installation location (macOS Intel): `/usr/local/bin/sqld`

**Note**: The `ensure-sqld.js` script configures the PATH internally for the Node.js process. You don't need to manually add Homebrew to your shell PATH for tests to work, but you may want to add it for manual use:

```bash
# Linux
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

# macOS Apple Silicon
eval "$(/opt/homebrew/bin/brew shellenv)"

# macOS Intel
eval "$(/usr/local/bin/brew shellenv)"
```

## Manual Installation (if automatic fails)

If automatic installation fails, you can manually install:

### Install Homebrew

**Linux:**
```bash
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

**macOS:**
```bash
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"  # Apple Silicon
# or
eval "$(/usr/local/bin/brew shellenv)"     # Intel
```

### Install sqld

```bash
brew tap libsql/sqld
brew install sqld
```

## Test Results

When tests run successfully, you should see:

- **@teekit/demo**: 3 tests passed
- **@teekit/kettle**: 32 tests passed, 1 skipped
- **@teekit/qvl**: 85 tests passed
- **@teekit/tunnel**: 56 tests passed, 6 skipped

**Note**: The `@teekit/images` and `@teekit/images-dstack` packages do not have test scripts, so npm will report errors for these workspaces. This is expected and does not indicate test failures.

## Troubleshooting

### Build Failures

If you see build errors, ensure all packages are built first:
```bash
npm run build
```

### sqld Not Found

If `sqld` is not found after installation:
1. Ensure Homebrew is in your PATH: `eval "$(brew shellenv)"`
2. Verify sqld installation: `which sqld` or `brew list sqld`
3. Check that `SQLD_BIN` environment variable is not set incorrectly

### CI Environment

The automatic installation is skipped in CI environments (when `CI=true`). CI should handle sqld installation separately.

## Test Framework

Tests use:
- **Ava**: Test runner (`ava --serial`)
- **tsx**: TypeScript execution (`--import=tsx`)
- Tests are located in `test/**/*.test.ts` in each package

## Package-Specific Notes

### @teekit/kettle
- Requires `sqld` to be running (automatically started by tests)
- Uses workerd for Cloudflare Workers compatibility
- Tests include database replication scenarios

### @teekit/demo
- Tests spawn server processes that need to start within timeout windows
- Uses sample quotes when TDX config.json is not available

### @teekit/qvl
- Tests quote verification without requiring external services
- Includes extensive test cases for SGX and TDX quotes

### @teekit/tunnel
- Tests include benchmark tests (skipped by default, run with `BENCHMARK=1`)
- Tests cover encryption, fetch API, and WebSocket functionality
