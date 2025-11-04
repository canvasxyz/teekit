#!/bin/bash
# Build script for Kettle Launcher Docker image
# Must be run from the monorepo root

set -e
set -o pipefail

# Get the script directory and monorepo root
# Check if we're in the right directory (should have packages/ directory)
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -d "$MONOREPO_ROOT/packages" ]; then
    echo "Error: This script must be run from the monorepo root"
    echo "Current directory: $(pwd)"
    echo "Expected monorepo root: $MONOREPO_ROOT"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default values
IMAGE_NAME="${IMAGE_NAME:-kettle-launcher}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DOCKERFILE="${DOCKERFILE:-packages/images-dstack/Dockerfile}"

echo "Building Docker image: $IMAGE_NAME:$IMAGE_TAG"
echo "Using Dockerfile: $DOCKERFILE"
echo "Building from: $MONOREPO_ROOT"

cd "$MONOREPO_ROOT"
docker build -f "$DOCKERFILE" -t "$IMAGE_NAME:$IMAGE_TAG" .

echo ""
echo "Build complete! Image: $IMAGE_NAME:$IMAGE_TAG"
echo ""
echo "To push to a registry:"
echo "  docker tag $IMAGE_NAME:$IMAGE_TAG your-registry/$IMAGE_NAME:$IMAGE_TAG"
echo "  docker push your-registry/$IMAGE_NAME:$IMAGE_TAG"
