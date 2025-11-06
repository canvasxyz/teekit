# Plan: Copying Development Workspace into VM Image

## Current Approach

The current build process:
1. **Bundle Creation**: `bundle.sh` uses esbuild to bundle `packages/kettle/services/cli.ts` into a single ESM file (`cli.bundle.js`)
2. **Pre-build Artifacts**: `scripts/prep_kettle.sh` compiles TypeScript, builds app/worker bundles, and generates manifest
3. **Image Integration**: `tdx-dummy/mkosi.build` copies:
   - CLI bundle → `/usr/bin/kettle`
   - Pre-built artifacts → `/usr/lib/kettle/` (app.ts, app.js, worker.js, externals.js, manifest.json)

## Proposed Approach: Copy Development Workspace

Instead of bundling, copy the entire development workspace into the VM image and rely on the workspace's native TypeScript/Node.js setup.

## Implementation Plan

### Phase 1: Workspace Structure Analysis

**Location in VM**: `/opt/teekit` or `/usr/local/lib/teekit`

**Contents to Copy**:
```
/opt/teekit/
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.base.json
├── packages/
│   ├── kettle/
│   │   ├── package.json
│   │   ├── services/
│   │   │   ├── cli.ts (source)
│   │   │   └── ...
│   │   ├── app.ts
│   │   └── ...
│   ├── qvl/
│   ├── tunnel/
│   └── ...
└── node_modules/ (after npm install)
```

### Phase 2: Build Script Modifications

**File**: `scripts/prep_kettle.sh` → Replace with `scripts/prep_workspace.sh`

**New Process**:
1. Ensure workspace dependencies are installed at repo root
2. Compile TypeScript for all packages (qvl, tunnel, kettle)
3. Copy entire workspace to a staging directory
4. Run `npm install --production=false` in staging (includes devDependencies needed for building)
5. Copy staged workspace to mkosi build directory

**File**: `tdx-dummy/mkosi.build`

**Changes**:
1. Copy entire workspace tree to `$DESTDIR/opt/teekit`
2. Create symlink: `/usr/bin/kettle` → `/opt/teekit/packages/kettle/services/lib/cli.js`
3. Or create wrapper script that `cd`s to workspace and runs CLI

### Phase 3: Node.js Version Management

**Issue**: Debian Trixie may not have Node.js 22 in repositories

**Solutions**:
1. **Option A**: Install Node.js 22 via NodeSource repository
   - Add NodeSource repository in mkosi.build
   - Install `nodejs` from NodeSource
   - Verify version matches requirements

2. **Option B**: Use Node Version Manager (nvm/fnvm)
   - Install nvm in post-install script
   - Install Node 22 via nvm
   - Update PATH in systemd service/environment

3. **Option C**: Bundle Node.js binary
   - Download Node.js 22 binary for Linux x64
   - Extract to `/opt/nodejs/` or `/usr/local/nodejs/`
   - Update PATH

**Recommended**: Option A (NodeSource) - most reliable for system-wide installation

### Phase 4: Build Dependencies

**Required in VM**:
- Node.js >= 22.0.0
- npm >= 10.9.0
- TypeScript (via npm)
- esbuild (via npm)
- All npm dependencies from workspace

**Installation Strategy**:
1. Add Node.js 22 to `mkosi.conf` BuildPackages (via NodeSource)
2. After workspace copy, run `npm install` in `/opt/teekit`
3. Compile TypeScript: `npm run build` (runs across all workspaces)

### Phase 5: CLI Execution

**Option 1: Direct Execution**
```bash
/usr/bin/kettle -> /opt/teekit/packages/kettle/services/lib/cli.js
```
Requires Node.js in PATH and proper shebang

**Option 2: Wrapper Script**
```bash
#!/bin/bash
cd /opt/teekit
exec node packages/kettle/services/lib/cli.js "$@"
```

**Option 3: npm script**
```bash
#!/bin/bash
cd /opt/teekit
exec npm --workspace packages/kettle run kettle -- "$@"
```

**Recommended**: Option 2 (wrapper script) - most flexible and explicit

### Phase 6: Runtime Considerations

**Build Artifacts**:
- Keep existing build process for app.js, worker.js, externals.js
- These can be built from workspace source in VM
- Or pre-built and copied (current approach)

**Workspace Dependencies**:
- All `node_modules` must be present
- TypeScript compilation outputs in `lib/` directories
- Workspace references must resolve correctly

## Potential Issues & Mitigations

### Issue 1: Node.js Version Mismatch

**Problem**: Debian Trixie repositories may only have Node.js 20.x or earlier, but workspace requires >= 22.0.0

**Impact**: CLI won't run, TypeScript compilation may fail

**Mitigation**: 
- Install Node.js 22 from NodeSource repository
- Add to `mkosi.conf` BuildPackages
- Verify version in post-install script

**Verification**:
```bash
node --version  # Should output v22.x.x or higher
```

### Issue 2: Image Size

**Problem**: Copying entire workspace + node_modules will significantly increase image size

**Current**: ~cli.bundle.js (single file, ~few MB)
**Proposed**: Entire workspace + node_modules (~100-500 MB)

**Impact**: Larger image size, longer build times, more disk space

**Mitigation**:
- Use `npm ci --production=false` but consider trimming
- Exclude unnecessary files (.git, test/, docs/, etc.)
- Consider using `--omit=optional` for optional dependencies
- Use `.dockerignore`-style patterns for copy

**Trade-off**: Acceptable if development/debugging benefits outweigh size

### Issue 3: Build Time

**Problem**: Installing npm dependencies in VM image build process will add significant time

**Impact**: Each mkosi build will include full `npm install` (~1-5 minutes)

**Mitigation**:
- Use mkosi cache for node_modules
- Pre-install in build script before mkosi
- Copy pre-built node_modules from host

**Optimization**: Cache node_modules separately, only reinstall if package.json changes

### Issue 4: TypeScript Compilation

**Problem**: TypeScript must be compiled in VM or pre-compiled on host

**Options**:
- **A**: Compile on host, copy compiled `lib/` directories
- **B**: Compile in VM during mkosi build
- **C**: Use tsx/ts-node at runtime (adds overhead)

**Recommended**: Option A (pre-compile on host) - faster builds, more reliable

### Issue 5: Workspace References

**Problem**: Workspace packages use TypeScript project references and workspace protocol

**Impact**: If not properly set up, imports like `@teekit/qvl` won't resolve

**Mitigation**:
- Ensure `package-lock.json` is copied
- Run `npm install` in workspace root
- Verify workspace links are created correctly
- Test imports in VM environment

### Issue 6: Path Dependencies

**Problem**: Workspace uses relative paths and workspace protocol

**Example**: `packages/kettle/package.json` has `"@teekit/qvl": "0.0.2"` but relies on workspace

**Impact**: npm install may not create proper workspace links

**Mitigation**:
- Ensure workspace structure is preserved
- Use `npm install` at root (not per-package)
- Verify `node_modules/@teekit/qvl` links to `packages/qvl`

### Issue 7: Native Dependencies

**Problem**: Some dependencies have native bindings (e.g., `@libsql/linux-x64-gnu`)

**Impact**: Native modules must match target architecture (x86-64)

**Mitigation**:
- Dependencies are already architecture-specific
- Ensure npm install runs on target architecture
- Verify optional dependencies resolve correctly

### Issue 8: Development vs Production

**Problem**: Workspace includes devDependencies (TypeScript, esbuild, etc.) needed for building

**Impact**: Need devDependencies for CLI to work, but they increase image size

**Mitigation**:
- Use `npm install --production=false` (default)
- Consider if CLI needs all devDependencies at runtime
- CLI bundle approach doesn't need them, but workspace approach does

### Issue 9: Source Maps & Debugging

**Problem**: With workspace approach, source maps may not work correctly

**Impact**: Debugging stack traces may point to wrong locations

**Mitigation**:
- Ensure source maps are generated and copied
- Test stack traces in VM
- Consider if debugging is actually needed in production VM

### Issue 10: Security Considerations

**Problem**: Including full source code in production image

**Impact**: Larger attack surface, source code exposure

**Mitigation**:
- This may be acceptable for development/testing images
- For production, consider if source code should be included
- Current bundle approach obfuscates source (somewhat)

### Issue 11: File Permissions

**Problem**: Workspace files need correct ownership and permissions

**Impact**: Node.js may not be able to read files, execute scripts

**Mitigation**:
- Set ownership in post-install script
- Ensure executable permissions on CLI scripts
- Use appropriate umask during copy

### Issue 12: Environment Variables

**Problem**: Node.js workspace may rely on environment variables

**Impact**: CLI may not work if environment isn't set up correctly

**Mitigation**:
- Set NODE_ENV, PATH, etc. in systemd service or wrapper script
- Ensure Node.js is in PATH
- Test CLI execution in VM

## Implementation Steps

1. **Create new prep script**: `scripts/prep_workspace.sh`
   - Install dependencies at repo root
   - Compile TypeScript
   - Stage workspace for copying

2. **Modify mkosi.build**: 
   - Copy workspace to `/opt/teekit`
   - Install Node.js 22 (via NodeSource)
   - Run `npm install` in workspace
   - Create CLI wrapper script

3. **Update mkosi.conf**:
   - Add NodeSource repository
   - Ensure Node.js 22 is installed
   - Add build packages if needed

4. **Create CLI wrapper**: `/usr/bin/kettle`
   - Wrapper script that runs CLI from workspace

5. **Test**:
   - Build image
   - Verify Node.js version
   - Test CLI execution
   - Verify workspace imports work

6. **Update documentation**:
   - Update README with new process
   - Document Node.js version requirements

## Recommended Approach

**Hybrid Approach**: Copy workspace but pre-compile TypeScript and pre-install dependencies on host, then copy to VM. This gives:
- ✅ Full source code access
- ✅ Ability to modify and rebuild
- ✅ Faster image builds (no npm install in VM)
- ✅ Smaller image size (no devDependencies if not needed)
- ✅ More reliable (less runtime compilation)

**Steps**:
1. On host: `npm install` at repo root
2. On host: `npm run build` (compiles all TypeScript)
3. Copy workspace + node_modules to VM
4. Copy compiled `lib/` directories
5. Create CLI wrapper that uses compiled code

## Alternative: Development Workspace Volume

Instead of copying into image, mount development workspace as volume:
- Pros: Always up-to-date, no copy needed, smaller image
- Cons: Requires external workspace, not self-contained, complexity

This may not be suitable for VM image distribution but could work for development/testing.
