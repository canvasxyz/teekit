# Plan: Copy Development Workspace to VM Image

## Current Approach Summary

The current build process:
1. **Bundles** the `packages/kettle/services/cli.ts` into a single ESM file using esbuild (`cli.bundle.js`)
2. **Pre-builds** the kettle app and worker files (`app.js`, `worker.js`, `externals.js`) using the CLI
3. **Copies** only the bundled CLI and pre-built artifacts to the VM image at:
   - `/usr/bin/kettle` (bundled CLI)
   - `/usr/lib/kettle/` (manifest, app.ts, app.js, worker.js, externals.js)
4. The VM image uses systemd service `kettle-launcher.service` to run `/usr/bin/kettle launch`

## Proposed Approach: Copy Development Workspace

### Plan Overview

Instead of bundling, copy the entire development workspace (or relevant packages) into the VM image and build/run it there.

### Implementation Steps

#### 1. **Create a Workspace Copy Directory in mkosi**
   - Add a new `mkosi.extra` or `SkeletonTrees` directory to include the workspace
   - Structure: `/opt/teekit/` (or `/usr/local/teekit/`)
   
#### 2. **Modify `tdx-dummy/mkosi.conf`**
   - Add workspace source tree to be copied:
     ```ini
     [Content]
     SkeletonTrees=/path/to/workspace:/opt/teekit
     ```

#### 3. **Update `tdx-dummy/mkosi.build`**
   - Remove bundling steps
   - Add workspace build steps:
     ```bash
     # Copy workspace
     WORKSPACE_DIR="$SRCDIR/../.."
     TEEKIT_DIR="$BUILDROOT/opt/teekit"
     
     # Copy only necessary packages (avoid node_modules)
     mkdir -p "$TEEKIT_DIR"
     rsync -a --exclude='node_modules' --exclude='build' --exclude='.git' \
       "$WORKSPACE_DIR/packages" "$TEEKIT_DIR/"
     rsync -a "$WORKSPACE_DIR/package.json" "$WORKSPACE_DIR/tsconfig.json" \
       "$WORKSPACE_DIR/tsconfig.base.json" "$TEEKIT_DIR/"
     
     # Install dependencies inside build environment
     cd "$TEEKIT_DIR"
     npm install --omit=dev
     npm run build --workspace packages/qvl --workspace packages/tunnel --workspace packages/kettle
     ```

#### 4. **Update `tdx-dummy/mkosi.postinst`**
   - Remove workerd global install (or keep if still needed)
   - Create symlink to kettle CLI:
     ```bash
     ln -s /opt/teekit/packages/kettle/services/lib/cli.js /usr/bin/kettle
     ```

#### 5. **Update `kettle-launcher.service`**
   - Modify to use workspace-based CLI:
     ```ini
     [Service]
     Environment="NODE_PATH=/opt/teekit/node_modules"
     ExecStart=/usr/bin/node /opt/teekit/packages/kettle/services/lib/cli.js launch /opt/teekit/manifest.json --port 3001 --db-dir /var/lib/kettle/db
     ```

#### 6. **Simplify Build Scripts**
   - Remove `bundle.sh` dependency
   - Remove `prep_kettle.sh` complexity
   - Update `setup_deps.sh` to not require esbuild bundling step

---

## Potential Issues and Considerations

### ❌ **CRITICAL ISSUE: Node.js Version Mismatch**

**Problem**: The workspace requires Node.js >= 22.0.0 (as specified in root `package.json`), but Debian Trixie's default `nodejs` package provides Node.js **18.x or 20.x**.

**Impact**: The kettle CLI and all packages will fail to run or may have runtime issues.

**Solutions**:
1. **Install Node.js 22 from NodeSource repository**
   - Add NodeSource repository in `mkosi.postinst`:
     ```bash
     curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
     apt-get install -y nodejs
     ```
   - **Downside**: Increases image size, adds external dependency, impacts reproducibility

2. **Use nvm or volta inside the VM**
   - Install Node.js version manager and specific version
   - **Downside**: Complex setup, larger image, slower boot

3. **Bundle a static Node.js binary**
   - Download and include Node.js 22 binary in the image
   - **Downside**: Large binary (~50-70MB), manual updates

4. **Downgrade workspace Node.js requirement**
   - Modify all `package.json` files to require Node.js >= 18.0.0
   - Test thoroughly to ensure no Node.js 22 specific features are used
   - **Downside**: May require code changes if using Node 22 features

### ⚠️ **Issue: Increased Image Size**

**Problem**: Copying the entire workspace with dependencies significantly increases image size.

**Current**:
- Bundled CLI: ~5-10 MB
- Pre-built artifacts: ~2-5 MB
- **Total**: ~10-15 MB

**With Workspace**:
- Source files: ~5 MB
- `node_modules` (production only): ~100-200 MB
- Built artifacts: ~10 MB
- **Total**: ~115-215 MB (10-20x increase)

**Mitigation**:
- Use `npm install --omit=dev` to exclude devDependencies
- Use `npm ci --production` for cleaner install
- Consider using `npm prune --production` after build
- Remove source TypeScript files after building (keep only `.js` files)

### ⚠️ **Issue: Build Time in mkosi**

**Problem**: Building the workspace inside mkosi increases build time.

**Impact**:
- TypeScript compilation: 30-60 seconds
- npm install: 60-120 seconds
- Total additional time: ~2-3 minutes per build

**Mitigation**:
- Cache `node_modules` between builds using mkosi cache
- Pre-compile and copy only built artifacts (hybrid approach)

### ⚠️ **Issue: Monorepo Workspace Dependencies**

**Problem**: The kettle package depends on `@teekit/qvl` and `@teekit/tunnel` from the monorepo.

**Current State**: npm workspaces handle this with symlinks.

**In VM**: Need to ensure workspace structure is preserved or dependencies are properly resolved.

**Solutions**:
1. **Preserve full monorepo structure** (current plan)
2. **Build and pack internal packages**: 
   ```bash
   cd packages/qvl && npm pack
   cd packages/tunnel && npm pack
   cd packages/kettle && npm install ../qvl/*.tgz ../tunnel/*.tgz
   ```

### ⚠️ **Issue: Build-time vs Runtime Dependencies**

**Problem**: The workspace has many `devDependencies` (TypeScript, esbuild, etc.) that are only needed for building, not running.

**Consideration**: 
- Need TypeScript and build tools in `BuildPackages` for mkosi build phase
- Should NOT include them in the final image
- `npm install --omit=dev` handles this for Node.js dependencies
- May need two-stage approach: build in one environment, copy to final image

### ⚠️ **Issue: Reproducibility**

**Problem**: npm install can produce different results based on:
- Lock file state
- Registry availability
- Timing of package updates

**Current Bundling**: More reproducible because it's done once outside mkosi.

**With Workspace**: Less reproducible if building inside mkosi each time.

**Mitigation**:
- Commit `package-lock.json` and use `npm ci` instead of `npm install`
- Consider using `npm ci --offline` with pre-populated cache
- Use `mkosi.cache` to cache npm packages between builds

### ℹ️ **Issue: Development Workflow Changes**

**Problem**: Changes to kettle code would require full image rebuild.

**Current**: Run `bundle.sh` and `prep_kettle.sh` before mkosi build.

**With Workspace**: Same, but now need to ensure workspace is in clean state.

**Benefits**: 
- Easier to test workspace code in VM environment
- Can potentially enable live development with volume mounts in dev profile

### ℹ️ **Issue: External Binary Dependencies**

**Problem**: Some npm packages have native binary dependencies that may not match the VM environment.

**Examples**:
- `@esbuild/linux-x64` (optional)
- `@libsql/linux-x64-gnu` (optional)
- `@rollup/rollup-linux-x64-gnu` (optional)

**Current State**: These are listed as `optionalDependencies` in kettle's package.json.

**Consideration**: Need to ensure these are built/installed for the correct architecture (x86-64 Linux).

---

## Recommended Hybrid Approach

Given the issues above, especially the **Node.js version mismatch**, I recommend a **hybrid approach**:

### Option A: Bundle with Workspace Available (Best of Both)

1. **Keep bundling for production** (current approach)
2. **Add workspace copy for development** (when using `--profile=devtools`)
3. Update `mkosi.profiles/devtools/mkosi.conf` to include workspace
4. Install Node.js 22 only in devtools profile

**Benefits**:
- Production images stay small and use bundled CLI
- Development images have full workspace for debugging/testing
- Node.js version issue only affects devtools profile
- Best of both worlds

### Option B: Static Node.js 22 Binary

1. Copy development workspace as planned
2. Bundle Node.js 22 static binary in the image
3. Use explicit path to Node.js 22 in systemd service

**Benefits**:
- No dependency on Debian package repositories
- Exact version control
- Simpler setup than external repositories

**Implementation**:
```bash
# In mkosi.build
NODE_VERSION="22.11.0"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt
ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node
ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm
```

### Option C: Keep Current Bundling Approach

**Recommendation**: Continue using the current bundling approach but improve it:

1. Keep `bundle.sh` and `prep_kettle.sh`
2. Improve bundle optimization
3. Add better caching
4. Focus on making bundled approach more maintainable

**Rationale**: The bundling approach solves the Node.js version problem, keeps images small, and is more reproducible.

---

## Comparison Matrix

| Aspect | Current (Bundle) | Full Workspace | Hybrid (A) | Static Node (B) |
|--------|------------------|----------------|------------|-----------------|
| Image Size | ✅ Small (10MB) | ❌ Large (200MB) | ⚠️ Medium (prod) / Large (dev) | ⚠️ Medium (80MB) |
| Node.js Version | ✅ Controlled | ❌ Mismatch | ✅ Controlled | ✅ Controlled |
| Build Time | ✅ Fast | ❌ Slow | ⚠️ Fast (prod) / Slow (dev) | ⚠️ Medium |
| Reproducibility | ✅ High | ⚠️ Medium | ✅ High (prod) | ✅ High |
| Debuggability | ⚠️ Limited | ✅ Full | ✅ Full (dev profile) | ✅ Full |
| Maintenance | ⚠️ Bundle script | ✅ Simple | ⚠️ Two paths | ✅ Simple |
| Development | ❌ Requires rebuild | ✅ Easy iteration | ✅ Easy (dev mode) | ✅ Easy iteration |

---

## Final Recommendation

**Use Option A: Hybrid Approach**

1. **Keep current bundling for production images**
   - Maintains small size, fast builds, reproducibility
   - Works with Debian's default Node.js version (bundle is compatible)

2. **Add workspace copy for devtools profile**
   - Modify `mkosi.profiles/devtools/mkosi.conf`:
     ```ini
     [Content]
     BuildPackages=nodejs
                   npm
                   curl
     Packages=nodejs
              npm
     ```
   
   - Add `mkosi.profiles/devtools/mkosi.build`:
     ```bash
     #!/bin/bash
     set -euxo pipefail
     
     # Install Node.js 22 from NodeSource
     curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
     apt-get install -y nodejs
     
     # Copy workspace
     WORKSPACE_DIR="$SRCDIR/../.."
     TEEKIT_DIR="$DESTDIR/opt/teekit"
     mkdir -p "$TEEKIT_DIR"
     
     # Copy workspace (exclude build artifacts and node_modules)
     rsync -a --exclude='node_modules' --exclude='build' --exclude='mkosi.*' \
           --exclude='.git' --exclude='*.tsbuildinfo' \
           "$WORKSPACE_DIR/" "$TEEKIT_DIR/"
     
     # Install and build
     cd "$TEEKIT_DIR"
     npm ci
     npm run build
     ```

3. **Document both modes clearly**
   - Production: Use default build (bundled)
   - Development: Use `make build-dev` (workspace available)

This approach solves all critical issues while providing the best development experience.
