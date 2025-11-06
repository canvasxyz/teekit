# Plan: Copy Development Workspace into VM Image

## Current Approach

The current build process:
1. **Bundling**: Uses `bundle.sh` to create a single ESM bundle (`cli.bundle.js`) from `packages/kettle/services/cli.ts` using esbuild
2. **Pre-build**: Runs `scripts/prep_kettle.sh` to:
   - Compile TypeScript services
   - Build CLI bundle
   - Build app and worker bundles
   - Generate manifest
   - Copy artifacts to `packages/images/kettle-artifacts/`
3. **Image Building**: In `tdx-dummy/mkosi.build`:
   - Copies the CLI bundle to `/usr/bin/kettle` in the VM
   - Copies pre-built artifacts to `/usr/lib/kettle/` (manifest.json, app.ts, app.js, worker.js, externals.js)

## Proposed Approach: Copy Development Workspace

Instead of bundling, copy the entire development workspace into the VM image so the CLI can run from source.

### High-Level Plan

1. **Copy Workspace Structure**
   - Copy the entire repository root (or at minimum: packages/kettle, packages/qvl, packages/tunnel, and root package.json/tsconfig files)
   - Maintain the npm workspace structure
   - Preserve all source files and build artifacts

2. **Install Dependencies**
   - Option A: Copy `node_modules` from build environment (if compatible)
   - Option B: Run `npm install` inside the VM during mkosi build
   - Option C: Copy `node_modules` and run `npm ci` to verify/update

3. **Update CLI Entry Point**
   - Instead of `/usr/bin/kettle` pointing to a bundle, point to the TypeScript source or compiled JS
   - Use a wrapper script or direct node execution

4. **Update Build Scripts**
   - Modify `mkosi.build` to copy workspace instead of bundle
   - Update `mkosi.postinst` if needed for any post-installation setup
   - Possibly update `prep_kettle.sh` to be less critical (or remove it)

### Detailed Implementation Steps

#### Step 1: Modify `mkosi.build`

Replace the bundle copying logic with workspace copying:

```bash
# Copy entire workspace to /usr/src/teekit (or similar)
WORKSPACE_DEST="$DESTDIR/usr/src/teekit"
mkdir -p "$WORKSPACE_DEST"

# Copy repository structure
# Option: Copy everything or selectively
cp -r "$REPO_ROOT/." "$WORKSPACE_DEST/" --exclude-from=<exclude-list>

# Or copy specific packages:
# - packages/kettle
# - packages/qvl  
# - packages/tunnel
# - Root package.json, tsconfig.base.json, tsconfig.json
# - package-lock.json (if exists)
```

#### Step 2: Install Dependencies

Option A - Copy node_modules (if compatible):
```bash
# Copy node_modules from build environment
cp -r "$REPO_ROOT/node_modules" "$WORKSPACE_DEST/"
# Copy package-specific node_modules
cp -r "$REPO_ROOT/packages/kettle/node_modules" "$WORKSPACE_DEST/packages/kettle/"
cp -r "$REPO_ROOT/packages/qvl/node_modules" "$WORKSPACE_DEST/packages/qvl/"
cp -r "$REPO_ROOT/packages/tunnel/node_modules" "$WORKSPACE_DEST/packages/tunnel/"
```

Option B - Install inside VM:
```bash
# In mkosi.build or mkosi.postinst
cd "$WORKSPACE_DEST"
npm ci --omit=dev  # Or npm install depending on needs
```

#### Step 3: Create CLI Wrapper

Create `/usr/bin/kettle` as a wrapper script:

```bash
#!/bin/bash
# Wrapper script to run kettle CLI from workspace
cd /usr/src/teekit/packages/kettle
exec node services/lib/cli.js "$@"
```

Or if running from TypeScript source:
```bash
#!/bin/bash
cd /usr/src/teekit/packages/kettle
exec node --loader tsx services/cli.ts "$@"
```

#### Step 4: Build TypeScript (if needed)

If copying source, ensure TypeScript is compiled:
```bash
# In mkosi.build
cd "$WORKSPACE_DEST"
npm run build  # Builds all packages
```

## Potential Issues and Considerations

### 1. Node.js Version Compatibility ⚠️ **CRITICAL**

**Issue**: The project requires Node.js >=22.0.0 (from root package.json and package dependencies).

**Current VM Setup**: Debian Trixie (testing) may have Node.js 20.x or 22.x. Needs verification.

**Verification Required**:
```bash
# Check Debian Trixie nodejs version
apt-cache policy nodejs  # In Debian Trixie environment
```

**Solution Options**:
- **Option A (Recommended)**: Use NodeSource repository to install Node.js 22+ in the VM
  - Add to `mkosi.postinst`:
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    ```
- **Option B**: Use a Node.js version manager (adds complexity, not ideal for production)
- **Option C**: Build Node.js from source (slow, complex, not recommended)
- **Option D**: Use a different base distribution that includes Node 22+ (e.g., Ubuntu 24.04)

**Recommendation**: 
1. First verify Node.js version in Debian Trixie
2. If < 22.0.0, add NodeSource repository setup in `mkosi.postinst`
3. Verify npm version >= 10.9.0 after installation

### 2. npm Version Compatibility

**Issue**: Root package.json requires npm >=10.9.0.

**Solution**: NodeSource Node.js 22+ includes a compatible npm version. Verify after installation.

### 3. Image Size

**Issue**: Copying the entire workspace with node_modules will significantly increase VM image size.

**Current**: Bundle (~few MB) + artifacts (~few MB) = ~10-50 MB
**Proposed**: Full workspace + node_modules = potentially 100-500 MB+ depending on dependencies

**Mitigation**:
- Use `npm ci --omit=dev` to exclude dev dependencies
- Use `npm prune --production` to remove unnecessary packages
- Consider excluding test files, documentation, etc.
- Use compression in the image

### 4. Native Module Compatibility

**Issue**: Some npm packages include native bindings that are architecture-specific:
- `@esbuild/linux-x64` (optional dependency)
- `@libsql/linux-x64-gnu` (optional dependency)  
- `@rollup/rollup-linux-x64-gnu` (optional dependency)

**Solution**: 
- Ensure these are installed for the correct architecture (x86-64)
- The optional dependencies should handle this automatically if the build environment matches the VM

### 5. Build Environment vs Runtime Environment

**Issue**: Dependencies built in the host environment may not work in the VM environment due to:
- Different Node.js versions
- Different system libraries
- Different architectures (though both should be x86-64)

**Solution**:
- Prefer installing dependencies inside the VM (`npm ci` in mkosi.build)
- Or ensure build environment matches VM environment exactly

### 6. TypeScript Compilation

**Issue**: If copying source TypeScript files, need to ensure they're compiled.

**Options**:
- Compile before copying (in prep_kettle.sh or mkosi.build)
- Compile after copying (in mkosi.build or mkosi.postinst)
- Use a TypeScript runtime like `tsx` or `ts-node` (adds runtime dependency)

**Recommendation**: Compile before or during mkosi.build to avoid runtime TypeScript dependency.

### 7. Workspace Structure Preservation

**Issue**: npm workspaces require specific directory structure and package.json configuration.

**Solution**: Ensure all workspace-related files are copied:
- Root `package.json` with workspaces configuration
- Root `tsconfig.json` and `tsconfig.base.json`
- `package-lock.json` (for reproducible installs)
- All package directories with their `package.json` files

### 8. Path Dependencies

**Issue**: The packages use workspace references:
- `@teekit/qvl: 0.0.2` (workspace dependency)
- `@teekit/tunnel: 0.0.2` (workspace dependency)

**Solution**: As long as workspace structure is preserved, npm will resolve these correctly. Ensure `package-lock.json` is present or run `npm install` in the workspace root.

### 9. Security Considerations

**Issue**: Copying entire development workspace may include:
- Source code that wasn't meant to be in production
- Test files
- Development scripts
- Git history (if .git is copied)

**Solution**:
- Exclude `.git`, `test/`, `*.md`, etc. from the copy
- Use a `.dockerignore`-style exclusion list
- Consider creating a "production" workspace structure

### 10. Performance

**Issue**: Running from source may be slower than bundled code:
- TypeScript compilation overhead if using tsx/ts-node
- More file system operations
- Larger memory footprint

**Solution**:
- Prefer compiled JavaScript over TypeScript source
- Use the compiled `services/lib/cli.js` instead of `services/cli.ts`

### 11. Git Dependencies (if any)

**Issue**: If any dependencies use git URLs, they may require git to be installed.

**Solution**: Ensure `git` is in BuildPackages (already present in mkosi.conf).

### 12. Optional Dependencies

**Issue**: The `@teekit/kettle` package has optional dependencies:
- `@esbuild/linux-x64`
- `@libsql/linux-x64-gnu`
- `@rollup/rollup-linux-x64-gnu`

**Solution**: These should install automatically if the platform matches. Ensure they're included in the VM's node_modules.

## Recommended Approach

### Hybrid Solution

1. **Copy Workspace Structure** (selective):
   - Copy `packages/kettle`, `packages/qvl`, `packages/tunnel`
   - Copy root `package.json`, `tsconfig.base.json`, `tsconfig.json`, `package-lock.json`
   - Exclude: `.git`, `test/`, `*.md`, `node_modules` (initially)

2. **Install Dependencies in VM**:
   - In `mkosi.build`, after copying workspace:
     ```bash
     cd "$WORKSPACE_DEST"
     npm ci --omit=dev
     ```
   - This ensures compatibility with VM's Node.js version

3. **Use Compiled JavaScript**:
   - Pre-compile TypeScript in `mkosi.build` or before copying
   - Use `services/lib/cli.js` instead of source
   - Avoid runtime TypeScript dependencies

4. **Update Node.js Version**:
   - Add NodeSource repository in `mkosi.postinst` to get Node.js 22+
   - Or use a different base image that includes Node 22+

5. **Create CLI Wrapper**:
   ```bash
   #!/bin/bash
   cd /usr/src/teekit/packages/kettle
   exec node services/lib/cli.js "$@"
   ```

### File Structure in VM

```
/usr/src/teekit/
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.base.json
├── node_modules/
├── packages/
│   ├── kettle/
│   │   ├── package.json
│   │   ├── services/
│   │   │   ├── lib/  (compiled JS)
│   │   │   └── *.ts  (source, for reference)
│   │   ├── node_modules/
│   │   └── ...
│   ├── qvl/
│   │   ├── package.json
│   │   ├── lib/  (compiled JS)
│   │   ├── node_modules/
│   │   └── ...
│   └── tunnel/
│       ├── package.json
│       ├── lib/  (compiled JS)
│       ├── node_modules/
│       └── ...
```

## Migration Checklist

- [ ] Determine Node.js version in Debian Trixie
- [ ] Add NodeSource setup or alternative Node.js 22+ installation
- [ ] Modify `mkosi.build` to copy workspace structure
- [ ] Update workspace copying to exclude unnecessary files
- [ ] Add `npm ci` step in `mkosi.build`
- [ ] Ensure TypeScript compilation happens (before or during build)
- [ ] Create `/usr/bin/kettle` wrapper script
- [ ] Update `mkosi.postinst` if needed
- [ ] Test that workspace dependencies resolve correctly
- [ ] Verify image size impact
- [ ] Test CLI functionality in VM
- [ ] Update `prep_kettle.sh` (may no longer need bundling step)
- [ ] Update documentation

## Alternative: Keep Bundle but Add Workspace

Another option is to keep the bundled CLI but also copy the workspace for development/debugging purposes. This would:
- Keep the current efficient bundle approach
- Add workspace for flexibility
- Allow switching between bundle and workspace modes
- Increase image size but provide more options

## Conclusion

Copying the development workspace is feasible but requires:
1. **Node.js 22+ installation** (main blocker - needs verification)
2. **Dependency installation** in the VM
3. **TypeScript compilation** before or during build
4. **Image size increase** (acceptable trade-off for flexibility)
5. **Proper workspace structure** preservation

The main advantage is flexibility and ability to modify/develop directly in the VM. The main disadvantage is increased complexity and image size.

## Summary

### Current State
- **Bundle approach**: Single ESM file (~few MB) + pre-built artifacts
- **Pros**: Small size, fast execution, no runtime dependencies
- **Cons**: Hard to modify, no source access, requires rebuild for changes

### Proposed State
- **Workspace approach**: Full development workspace with source code
- **Pros**: Full source access, can modify/develop in VM, flexible
- **Cons**: Larger image size (~100-500MB), requires Node.js 22+, more complex setup

### Key Decisions Needed
1. **Verify Node.js version** in Debian Trixie (may need NodeSource setup)
2. **Choose dependency strategy**: Copy node_modules vs install in VM
3. **Choose compilation strategy**: Pre-compile vs compile in VM
4. **Determine acceptable image size** increase

### Recommended Next Steps
1. **Research**: Check Debian Trixie Node.js version
2. **Prototype**: Implement minimal workspace copy in a test branch
3. **Measure**: Compare image sizes and build times
4. **Test**: Verify CLI functionality with workspace approach
5. **Decide**: Based on results, proceed with full implementation or hybrid approach
