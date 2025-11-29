#!/bin/bash
set -euo pipefail

# Script to measure and report on build artifacts for consistency checking
# Usage: measure_build.sh <stage_name> <output_dir>

STAGE_NAME="${1:-unknown}"
OUTPUT_DIR="${2:-build}"

echo "=== Build Measurements for Stage: $STAGE_NAME ==="
echo "Output directory: $OUTPUT_DIR"
echo ""

# Create measurements directory
MEASUREMENTS_DIR="$OUTPUT_DIR/measurements"
mkdir -p "$MEASUREMENTS_DIR"

# Function to generate file listing with checksums
generate_file_list() {
    local dir="$1"
    local output_file="$2"
    
    if [ ! -d "$dir" ]; then
        echo "Directory not found: $dir"
        return 1
    fi
    
    echo "Generating file list for: $dir"
    find "$dir" -type f -exec sha256sum {} \; | sort > "$output_file" || true
    find "$dir" -type f -exec stat -c "%s %y %n" {} \; 2>/dev/null | sort > "${output_file}.metadata" || \
    find "$dir" -type f -exec stat -f "%z %Sm %N" {} \; 2>/dev/null | sort > "${output_file}.metadata" || true
}

# Function to measure directory
measure_directory() {
    local dir="$1"
    local name="$2"
    
    if [ ! -d "$dir" ]; then
        echo "Directory not found: $dir (skipping)"
        return 0
    fi
    
    echo "Measuring directory: $dir"
    generate_file_list "$dir" "$MEASUREMENTS_DIR/${name}_files.txt"
    
    # Calculate total size
    local total_size=$(du -sb "$dir" 2>/dev/null | cut -f1 || echo "0")
    echo "$total_size" > "$MEASUREMENTS_DIR/${name}_size.txt"
    
    # Count files
    local file_count=$(find "$dir" -type f | wc -l)
    echo "$file_count" > "$MEASUREMENTS_DIR/${name}_count.txt"
    
    echo "  Size: $(numfmt --to=iec-i --suffix=B $total_size 2>/dev/null || echo "${total_size} bytes")"
    echo "  Files: $file_count"
}

# Function to measure specific files
measure_file() {
    local file="$1"
    local name="$2"
    
    if [ ! -f "$file" ]; then
        echo "File not found: $file (skipping)"
        return 0
    fi
    
    echo "Measuring file: $file"
    sha256sum "$file" > "$MEASUREMENTS_DIR/${name}_sha256.txt"
    
    local size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo "0")
    echo "$size" > "$MEASUREMENTS_DIR/${name}_size.txt"
    
    echo "  SHA256: $(cat "$MEASUREMENTS_DIR/${name}_sha256.txt" | cut -d' ' -f1)"
    echo "  Size: $(numfmt --to=iec-i --suffix=B $size 2>/dev/null || echo "${size} bytes")"
}

# Measure based on stage
case "$STAGE_NAME" in
    stage1-base)
        # Stage 1: Base image only
        measure_directory "$OUTPUT_DIR" "base_image"
        if [ -f "$OUTPUT_DIR/tdx-debian.efi" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian.efi" "base_efi"
        fi
        ;;
    stage2-kernel)
        # Stage 2: Base + kernel
        measure_directory "$OUTPUT_DIR" "kernel_image"
        if [ -f "$OUTPUT_DIR/tdx-debian.efi" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian.efi" "kernel_efi"
        fi
        # Measure kernel files
        if [ -d "$OUTPUT_DIR/usr/lib/modules" ]; then
            measure_directory "$OUTPUT_DIR/usr/lib/modules" "kernel_modules"
        fi
        ;;
    stage3-sqld)
        # Stage 3: Base + kernel + sqld
        measure_directory "$OUTPUT_DIR" "sqld_image"
        if [ -f "$OUTPUT_DIR/tdx-debian.efi" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian.efi" "sqld_efi"
        fi
        # Measure sqld binary
        if [ -f "$OUTPUT_DIR/usr/bin/sqld" ]; then
            measure_file "$OUTPUT_DIR/usr/bin/sqld" "sqld_binary"
        fi
        ;;
    stage4-kettle)
        # Stage 4: Base + kernel + sqld + tdx-kettle
        measure_directory "$OUTPUT_DIR" "kettle_image"
        if [ -f "$OUTPUT_DIR/tdx-debian.efi" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian.efi" "kettle_efi"
        fi
        # Measure kettle artifacts
        if [ -d "$OUTPUT_DIR/usr/lib/kettle" ]; then
            measure_directory "$OUTPUT_DIR/usr/lib/kettle" "kettle_files"
        fi
        if [ -f "$OUTPUT_DIR/usr/bin/kettle" ]; then
            measure_file "$OUTPUT_DIR/usr/bin/kettle" "kettle_cli"
        fi
        ;;
    stage5-gcp)
        # Stage 5: Full GCP build
        measure_directory "$OUTPUT_DIR" "gcp_image"
        # GCP profile creates tar.gz - check both possible names
        if [ -f "$OUTPUT_DIR/tdx-debian-stage5.tar.gz" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian-stage5.tar.gz" "gcp_tar"
        elif [ -f "$OUTPUT_DIR/tdx-debian.tar.gz" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian.tar.gz" "gcp_tar"
        fi
        if [ -f "$OUTPUT_DIR/tdx-debian-stage5.efi" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian-stage5.efi" "gcp_efi"
        elif [ -f "$OUTPUT_DIR/tdx-debian.efi" ]; then
            measure_file "$OUTPUT_DIR/tdx-debian.efi" "gcp_efi"
        fi
        ;;
    *)
        echo "Unknown stage: $STAGE_NAME"
        echo "Measuring all available artifacts..."
        measure_directory "$OUTPUT_DIR" "output"
        ;;
esac

# Generate summary
SUMMARY_FILE="$MEASUREMENTS_DIR/summary.json"
echo "Generating summary: $SUMMARY_FILE"

cat > "$SUMMARY_FILE" <<EOF
{
  "stage": "$STAGE_NAME",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_date_epoch": "${SOURCE_DATE_EPOCH:-0}",
  "output_dir": "$OUTPUT_DIR",
  "measurements_dir": "$MEASUREMENTS_DIR"
}
EOF

echo ""
echo "=== Measurement Summary ==="
cat "$SUMMARY_FILE"
echo ""
echo "Measurements saved to: $MEASUREMENTS_DIR"
echo ""

# List all measurement files
echo "Measurement files:"
ls -lh "$MEASUREMENTS_DIR" | tail -n +2 || echo "No measurements generated"
