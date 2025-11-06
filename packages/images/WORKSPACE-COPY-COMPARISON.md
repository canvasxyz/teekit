# Comparison: Bundle vs Workspace Copy

## Current Approach: Bundle

### How It Works
1. `bundle.sh` uses esbuild to bundle `packages/kettle/services/cli.ts` into single ESM file
2. Bundle includes `createRequire` polyfill for CommonJS compatibility
3. Pre-built artifacts (app.js, worker.js, etc.) are copied separately
4. Single file copied to `/usr/bin/kettle`

### Pros
- ✅ Small image size (~few MB for bundle)
- ✅ Fast build (no npm install in VM)
- ✅ Self-contained (single file)
- ✅ Works with any Node.js version (bundle handles compatibility)
- ✅ Simple deployment

### Cons
- ❌ No source code access in VM
- ❌ Cannot modify or rebuild in VM
- ❌ Harder to debug (bundled code)
- ❌ Separate build process for artifacts
- ❌ Requires esbuild on host

## Proposed Approach: Workspace Copy

### How It Works
1. Copy entire workspace to `/opt/teekit`
2. Install Node.js 22 in VM
3. Run `npm install` in workspace
4. Compile TypeScript (or pre-compile on host)
5. Create CLI wrapper script

### Pros
- ✅ Full source code access
- ✅ Can modify and rebuild in VM
- ✅ Better debugging (source maps, original source)
- ✅ Uses standard npm/TypeScript tooling
- ✅ No custom bundling step

### Cons
- ❌ Large image size (~100-500 MB)
- ❌ Slower builds (npm install, compilation)
- ❌ Requires Node.js 22 in VM
- ❌ More complex setup
- ❌ More dependencies to manage

## Side-by-Side Comparison

| Aspect | Bundle | Workspace Copy |
|--------|--------|----------------|
| **Image Size** | ~few MB | ~100-500 MB |
| **Build Time** | Fast (~seconds) | Slower (~1-5 min) |
| **Node.js Version** | Any (works with bundle) | Must be 22+ |
| **Source Code** | No | Yes |
| **Modify/Rebuild** | No | Yes |
| **Debugging** | Difficult | Easy |
| **Dependencies** | Bundled | npm install needed |
| **Complexity** | Low | Medium-High |
| **Setup Time** | Minimal | Requires Node.js setup |

## Use Case Analysis

### Use Bundle When:
- ✅ Production deployment
- ✅ Minimal image size is critical
- ✅ Source code shouldn't be in image
- ✅ Fast builds are important
- ✅ No need to modify code in VM

### Use Workspace Copy When:
- ✅ Development/testing images
- ✅ Need to debug or modify code
- ✅ Want full development environment
- ✅ Image size is not a concern
- ✅ Need to build/rebuild in VM

## Hybrid Approach

**Best of Both Worlds**:
1. Pre-build workspace on host (npm install, compile)
2. Copy workspace + compiled code + node_modules to VM
3. Skip npm install and compilation in VM
4. Still get full source code access

**Benefits**:
- Faster builds (no npm install in VM)
- Smaller than full dev setup (can exclude tests, docs)
- Full source code available
- Can still rebuild if needed

## Recommendation

**For Development/Testing**: Use workspace copy approach
- Full debugging capabilities
- Can modify and test changes
- Better development experience

**For Production**: Keep bundle approach
- Smaller images
- Faster deployments
- No source code exposure

**For Hybrid**: Pre-build workspace, copy to VM
- Best balance of features and performance
- Recommended for most use cases

## Implementation Complexity

### Bundle (Current)
- **Files to Modify**: 2-3
- **New Dependencies**: 0
- **Build Time Impact**: None
- **Risk Level**: Low

### Workspace Copy
- **Files to Modify**: 4-5
- **New Dependencies**: Node.js 22
- **Build Time Impact**: +1-5 minutes
- **Risk Level**: Medium

## Decision Matrix

Choose **Bundle** if:
- Image size < 50 MB is critical
- Build time < 1 minute is critical
- Production deployment
- No need for debugging

Choose **Workspace Copy** if:
- Development/testing environment
- Need source code access
- Image size < 500 MB is acceptable
- Build time < 10 minutes is acceptable

## Migration Path

If adopting workspace copy:
1. Phase 1: Keep bundle as fallback
2. Phase 2: Add workspace copy option (flag/profile)
3. Phase 3: Test thoroughly
4. Phase 4: Make workspace copy default for dev images
5. Phase 5: Keep bundle for production images

This allows gradual migration and testing.
