# Summary: Copying Development Workspace into VM Image

## Executive Summary

**Current**: Single bundled CLI file (`cli.bundle.js`) copied to `/usr/bin/kettle`
**Proposed**: Entire development workspace copied to `/opt/teekit` with full source code

## Key Findings

### Node.js Version Requirements
- **Required**: Node.js >= 22.0.0 (from root package.json and all packages)
- **Current VM**: Debian Trixie with `nodejs` package (likely Node 20.x or earlier)
- **Solution Needed**: Install Node.js 22 from NodeSource repository or bundle Node.js binary

### Workspace Dependencies
- **Monorepo**: Uses npm workspaces with 3 packages (kettle, qvl, tunnel)
- **Build Tools**: Requires TypeScript, esbuild, and devDependencies
- **Native Modules**: Has optional dependencies like `@libsql/linux-x64-gnu`
- **Size Impact**: ~100-500 MB (workspace + node_modules) vs ~few MB (bundle)

## Implementation Plan

### Phase 1: Setup Node.js 22
1. Add NodeSource repository to mkosi.conf
2. Install Node.js 22 in BuildPackages
3. Verify version in post-install

### Phase 2: Copy Workspace
1. Pre-build on host: `npm install && npm run build`
2. Copy entire workspace to `/opt/teekit` in VM
3. Copy compiled `lib/` directories
4. Copy `node_modules/` (or reinstall in VM)

### Phase 3: Create CLI Wrapper
Create `/usr/bin/kettle` wrapper script:
```bash
#!/bin/bash
cd /opt/teekit
exec node packages/kettle/services/lib/cli.js "$@"
```

## Critical Issues

### 1. Node.js Version Mismatch
- **Risk**: HIGH - Debian Trixie may not have Node 22
- **Fix**: Install from NodeSource repository

### 2. Image Size Increase
- **Risk**: MEDIUM - 10-100x size increase
- **Impact**: Larger images, slower builds
- **Acceptable**: If development/debugging benefits are needed

### 3. Build Time
- **Risk**: MEDIUM - npm install adds 1-5 minutes
- **Mitigation**: Pre-install on host, copy node_modules

### 4. TypeScript Compilation
- **Risk**: LOW - Can pre-compile on host
- **Solution**: Compile before copying, copy `lib/` directories

### 5. Workspace Resolution
- **Risk**: MEDIUM - Workspace links must work
- **Solution**: Preserve workspace structure, use `npm install` at root

## Recommended Approach

**Hybrid Pre-Build Approach**:
1. ✅ Install dependencies on host (`npm install`)
2. ✅ Compile TypeScript on host (`npm run build`)
3. ✅ Copy workspace + compiled code + node_modules to VM
4. ✅ Create CLI wrapper script
5. ✅ No npm install or compilation in VM

**Benefits**:
- Faster builds (no npm install in VM)
- Reliable (pre-tested on host)
- Full source code available
- Can modify and rebuild in VM

**Trade-offs**:
- Larger image size (~100-500 MB vs few MB)
- More complex build process
- Requires matching Node.js version on host and VM

## Files to Modify

1. `scripts/prep_kettle.sh` → `scripts/prep_workspace.sh`
   - Change from bundling to workspace preparation

2. `tdx-dummy/mkosi.build`
   - Copy workspace instead of bundle
   - Install Node.js 22
   - Create CLI wrapper

3. `tdx-dummy/mkosi.conf`
   - Add NodeSource repository
   - Add Node.js 22 to BuildPackages

4. `bundle.sh` (optional)
   - Can be deprecated if workspace approach is adopted

## Next Steps

1. Verify Node.js version in Debian Trixie repositories
2. Test NodeSource installation in mkosi build
3. Create workspace copy script
4. Modify mkosi.build to copy workspace
5. Test CLI execution in VM
6. Measure image size impact
7. Document new process
