#!/bin/bash
# Build script for Kettle Launcher Docker image

set -e
set -o pipefail

# Resolve script directory without changing caller's CWD
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

# Calculate monorepo root without changing directories
# packages/images-dstack/ -> ../../ is the repo root
MONOREPO_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Verify expected structure
if [ ! -d "$MONOREPO_ROOT/packages" ]; then
    echo "Error: Could not locate monorepo root from script location"
    echo "Script directory: $SCRIPT_DIR"
    echo "Calculated monorepo root: $MONOREPO_ROOT"
    exit 1
fi

# Enforce execution from monorepo root
CURRENT_DIR="$(pwd -P)"
if [ "$CURRENT_DIR" != "$MONOREPO_ROOT" ]; then
    echo "Error: This script must be run from the monorepo root"
    echo "Current directory: $CURRENT_DIR"
    echo "Expected monorepo root: $MONOREPO_ROOT"
    exit 1
fi

# Default values
IMAGE_NAME="${IMAGE_NAME:-kettle-launcher}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DOCKERFILE="${DOCKERFILE:-packages/images-dstack/Dockerfile}"
# Use absolute path for Dockerfile to avoid changing CWD
DOCKERFILE_PATH="$MONOREPO_ROOT/$DOCKERFILE"

echo "Building Docker image: $IMAGE_NAME:$IMAGE_TAG"
echo "Using Dockerfile: $DOCKERFILE_PATH"
echo "Build context: $MONOREPO_ROOT"

# Do not change the current working directory; pass explicit paths
docker build -f "$DOCKERFILE_PATH" -t "$IMAGE_NAME:$IMAGE_TAG" "$MONOREPO_ROOT"

echo ""
echo "Build complete! Image: $IMAGE_NAME:$IMAGE_TAG"
echo ""
echo "To push to a registry:"
echo "  docker tag $IMAGE_NAME:$IMAGE_TAG your-registry/$IMAGE_NAME:$IMAGE_TAG"
echo "  docker push your-registry/$IMAGE_NAME:$IMAGE_TAG"
