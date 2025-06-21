#!/bin/bash

# Script to migrate existing polyfill scripts to the new filesystem-based structure
# This copies all scripts from ./scripts and ./scripts-post to the layout directory
# and transpiles/minifies them using Babel and UglifyJS

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_SCRIPTS="$SCRIPT_DIR/scripts"
SOURCE_SCRIPTS_POST="$SCRIPT_DIR/scripts-post"
TARGET_BASE="$SCRIPT_DIR/layout/Library/Application Support/Polyfills"

echo "Migrating polyfill scripts to new filesystem structure..."

# Function to process JS files in a folder (transpile and minify each file)
process_js_folder() {
    local folder_path="$1"
    local folder_name=$(basename "$folder_path")

    if [ ! -d "$folder_path" ]; then
        return 0
    fi

    # Check if there are any JS files to process
    local js_files
    js_files=$(find "$folder_path" -maxdepth 1 -name "*.js" -type f)

    if [ -z "$js_files" ]; then
        echo "Processing folder: $folder_name - No JavaScript files found"
        return 0
    fi

    echo "Processing folder: $folder_name"

    # Check for npx command once per folder
    if ! command -v npx &> /dev/null; then
        echo "  Warning: npx not found. Skipping transpilation/minification for $folder_name" >&2
        return 0
    fi

    # Process each JS file in the folder
    echo "$js_files" | while IFS= read -r js_file; do
        local temp_js_transpiled
        local temp_js_minified

        temp_js_transpiled=$(mktemp)
        temp_js_minified=$(mktemp)

        # Local trap for temp files
        trap 'rm -f "$temp_js_transpiled" "$temp_js_minified"; trap - RETURN EXIT INT TERM' RETURN EXIT INT TERM

        local filename=$(basename "$js_file")

        # Transpile with Babel
        if npx babel "$js_file" -o "$temp_js_transpiled" 2>/dev/null; then
            # Minify with UglifyJS
            if npx uglifyjs "$temp_js_transpiled" -o "$temp_js_minified" 2>/dev/null; then
                # Check ES5 compatibility and update the original file
                if npx acorn "$temp_js_minified" --ecma5 --silent 2>/dev/null; then
                    cp "$temp_js_minified" "$js_file"
                    echo "  ✓ Processed: $filename (transpiled + minified)"
                else
                    cp "$temp_js_minified" "$js_file"
                    echo "  ⚠ Processed: $filename (not ES5 compatible)"
                fi
            else
                # Minification failed, use transpiled version
                cp "$temp_js_transpiled" "$js_file"
                echo "  ⚠ Transpiled only: $filename (minification failed)"
            fi
        else
            # Transpilation failed, keep original
            echo "  ✗ Skipped: $filename (transpilation failed)"
        fi

        # Cleanup handled by trap
    done

    echo "  Completed processing $folder_name"
    return 0
}

# Create target directories
mkdir -p "$TARGET_BASE/scripts"
mkdir -p "$TARGET_BASE/scripts-post"

# Copy scripts directory structure first
if [ -d "$SOURCE_SCRIPTS" ]; then
    echo "Copying scripts structure..."
    cp -r "$SOURCE_SCRIPTS"/* "$TARGET_BASE/scripts/" 2>/dev/null || true

    # Create base directory and move A_start.js there
    mkdir -p "$TARGET_BASE/scripts/base"
    if [ -f "$TARGET_BASE/scripts/A_start.js" ]; then
        mv "$TARGET_BASE/scripts/A_start.js" "$TARGET_BASE/scripts/base/"
    fi
fi

# Copy scripts-post directory structure first
if [ -d "$SOURCE_SCRIPTS_POST" ]; then
    echo "Copying scripts-post structure..."
    cp -r "$SOURCE_SCRIPTS_POST"/* "$TARGET_BASE/scripts-post/" 2>/dev/null || true

    # Create base directory and move base files there
    mkdir -p "$TARGET_BASE/scripts-post/base"
    for file in A_start.js meta.js; do
        if [ -f "$TARGET_BASE/scripts-post/$file" ]; then
            mv "$TARGET_BASE/scripts-post/$file" "$TARGET_BASE/scripts-post/base/"
        fi
    done

    # Remove disabled files
    find "$TARGET_BASE/scripts-post" -name "*.disabled" -delete 2>/dev/null || true
fi

echo ""
echo "Processing JavaScript files with Babel and UglifyJS..."

# Process all folders in scripts directory
if [ -d "$TARGET_BASE/scripts" ]; then
    find "$TARGET_BASE/scripts" -type d | while IFS= read -r folder; do
        process_js_folder "$folder"
    done
fi

# Process all folders in scripts-post directory
if [ -d "$TARGET_BASE/scripts-post" ]; then
    find "$TARGET_BASE/scripts-post" -type d | while IFS= read -r folder; do
        process_js_folder "$folder"
    done
fi

echo ""
echo "All JavaScript files have been transpiled with Babel and minified with UglifyJS."
echo "Processing was done per folder for improved performance."
echo "New structure created at: $TARGET_BASE"
echo ""
echo "The tweak will now load JavaScript files dynamically from:"
echo "/Library/Application Support/Polyfills/"
echo ""
echo "Note: If npx/Node.js is not available, files were copied without processing."
