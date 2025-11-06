# Copying Development Workspace into VM Image - Documentation Index

This directory contains analysis and planning documents for copying the development workspace into the mkosi-generated VM image instead of bundling the CLI.

## Documents

1. **WORKSPACE-COPY-SUMMARY.md** - Executive summary with key findings and recommendations
2. **WORKSPACE-COPY-PLAN.md** - Detailed implementation plan with all potential issues
3. **WORKSPACE-COPY-COMPARISON.md** - Side-by-side comparison of bundle vs workspace approaches
4. **scripts/prep_workspace_example.sh** - Example script for preparing workspace
5. **tdx-dummy/mkosi.build.workspace-example** - Example mkosi.build modification

## Quick Reference

### Current Approach (Bundle)
- Single bundled file: `cli.bundle.js` → `/usr/bin/kettle`
- Size: ~few MB
- Build time: Fast
- Source code: No

### Proposed Approach (Workspace Copy)
- Entire workspace: `/opt/teekit`
- Size: ~100-500 MB
- Build time: +1-5 minutes
- Source code: Yes

### Key Requirements
- **Node.js**: >= 22.0.0 (Debian Trixie may not have this)
- **Solution**: Install from NodeSource repository
- **Dependencies**: Full npm workspace installation

### Critical Issues
1. **Node.js Version** - Must install Node 22 (HIGH priority)
2. **Image Size** - 10-100x larger (MEDIUM priority)
3. **Build Time** - Adds npm install time (MEDIUM priority)
4. **TypeScript Compilation** - Should pre-compile on host (LOW priority)

## Recommended Next Steps

1. Review comparison document to decide if workspace copy is needed
2. If proceeding, start with hybrid approach (pre-build on host)
3. Install Node.js 22 from NodeSource in mkosi.conf
4. Modify prep script to stage workspace
5. Update mkosi.build to copy workspace
6. Test thoroughly before production use

## Questions to Consider

- **Is source code access needed in VM?**
  - Yes → Use workspace copy
  - No → Keep bundle

- **Is image size critical?**
  - Yes → Use bundle
  - No → Workspace copy acceptable

- **Is build time critical?**
  - Yes → Use bundle or hybrid (pre-build)
  - No → Full workspace copy

- **Is this for production or development?**
  - Production → Bundle
  - Development → Workspace copy
