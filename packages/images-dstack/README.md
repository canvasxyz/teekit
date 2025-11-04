# @teekit/dstack

Build tools for packaging @teekit/kettle as a Docker container on
Dstack with external manifest configuration.

## Deployment Steps

1. **Generate a manifest**:

   Build a manifest file for your application. If you have not done
   so already, this will prompt you to create a GitHub personal access
   token and store it as GITHUB_TOKEN.

   ```
   kettle publish app.ts
   ```

2. **Build the Docker image**:

   The Dockerfile must be built from the monorepo root, not from the
   `packages/images-dstack` directory, because it needs access to
   workspace dependencies (`qvl`, `tunnel`, and `kettle`).

   ```
   ./packages/images-dstack/docker-build.sh
   ```

3. **Run with docker-compose**:

   ```
   # Option A: Using environment variable
   export KETTLE_MANIFEST="https://gist.githubusercontent.com/.../manifest.json"
   docker-compose -f packages/images-dstack/docker-compose.yml up

   # Option B: Using mounted file
   # Edit docker-compose.yml to uncomment the volume mount line
   docker-compose -f packages/images-dstack/docker-compose.yml up
   ```

4. **Deploy to Dstack**:
   - Push the image to a registry: `docker push registry/kettle-launcher:latest`
   - Upload `docker-compose.yml` to Phala Cloud/Dstack
   - Configure the `KETTLE_MANIFEST` environment variable
   - Deploy and obtain attestation measurements

## Measurements Reported by Confidential Container

When deployed on Dstack, the Confidential Virtual Machine (CVM) reports the following measurements as part of the Remote Attestation process:

### RTMR (Runtime Measurement Registers)

1. **RTMR0 (Firmware & Launch Environment)**
   - TDX firmware (TDVF) measurements
   - Root of trust for the TEE environment
   - Hardware and firmware state

2. **RTMR1 (Bootloader & Kernel)**
   - Bootloader measurements
   - Linux kernel hash
   - Ensures bootloader and kernel haven't been tampered with

3. **RTMR2 (Initial Userspace & Drivers)**
   - Initial userspace measurements
   - Driver measurements
   - Early boot environment verification

4. **RTMR3 (Application Manifests & Runtime Libraries)**
   - **Container image measurements**: Hash of the Docker image layers
   - **Application code measurements**: Hash of the Kettle launcher code
   - **Manifest measurements**: Hash of the manifest file (if mounted)
   - **Dynamic libraries**: Runtime library measurements
   - **Environment configuration**: Measurements of critical environment variables

### What Gets Measured

The attestation process measures:
- **Container image**: The Docker image layers and their integrity
- **Application binaries**: The compiled Kettle launcher code
- **Manifest file**: If using a mounted manifest file, its hash is measured
- ⚠️ **Environment variables**: Critical environment variables may be measured (depends on Dstack configuration)
- **Runtime libraries**: Dependencies loaded at runtime
- **TEE firmware**: The TDX firmware and hardware state

## License

MIT (C) 2025 Canvas Technologies, Inc.