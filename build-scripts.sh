#!/bin/bash

# Script to build and optimize polyfill scripts for packaging
# This processes all scripts from ./scripts, ./scripts-priority and ./scripts-post, transpiles and minifies them
# for optimal package size and runtime performance
#
# Usage: ./build-scripts.sh [--force]
#   --force: Force rebuild all files regardless of whether they've changed

set -e

# Parse command line arguments
FORCE_REBUILD=false
if [[ "$1" == "--force" ]]; then
    FORCE_REBUILD=true
    echo "Force rebuild mode: all files will be processed"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_SCRIPTS="$SCRIPT_DIR/scripts"
SOURCE_SCRIPTS_PRIORITY="$SCRIPT_DIR/scripts-priority"
SOURCE_SCRIPTS_POST="$SCRIPT_DIR/scripts-post"
TARGET_BASE="$SCRIPT_DIR/layout/Library/Application Support/Polyfills"
CACHE_FILE="$SCRIPT_DIR/.build-cache-${DEBUG:-0}"
ARTIFACT_DIR="$SCRIPT_DIR/.build-artifacts-${DEBUG:-0}"
BUILD_STAMP="$SCRIPT_DIR/.build-stamp"
CURRENT_BUILD_STAMP="DEBUG=${DEBUG:-0}"

echo "Building and optimizing polyfill scripts..."

mkdir -p "$ARTIFACT_DIR"

# layout/ is shared; per-mode built outputs live in .build-artifacts-0 / .build-artifacts-1.
if [ -f "$BUILD_STAMP" ]; then
    CACHED_BUILD_STAMP="$(cat "$BUILD_STAMP")"
    if [ "$CACHED_BUILD_STAMP" != "$CURRENT_BUILD_STAMP" ]; then
        echo "Build mode changed ($CACHED_BUILD_STAMP -> $CURRENT_BUILD_STAMP), using artifact cache for this mode"
    fi
fi
echo "$CURRENT_BUILD_STAMP" >"$BUILD_STAMP"

# Set UglifyJS options based on DEBUG environment variable
if [ "$DEBUG" = "1" ]; then
    UGLIFY_COMPRESS="arrows=false,global_defs={DEBUG:true}"
    echo "Debug build: keeping debug logs"
else
    UGLIFY_COMPRESS="arrows=false,drop_console=true,global_defs={DEBUG:false}"
    echo "Release build: stripping debug logs"
fi

# Function to get file checksum for change detection
get_file_checksum() {
    local file_path="$1"
    if [ -f "$file_path" ]; then
        shasum -a 256 "$file_path" | cut -d' ' -f1
    else
        echo ""
    fi
}

# Flip `var __*_DEBUG__ = false` to true after Babel. Uglify global_defs cannot
# override locally-declared DEBUG constants. Polyfills gate logs with __PF_DEBUG__.
apply_debug_flags() {
    local file="$1"
    if [ "$DEBUG" != "1" ] || [ ! -f "$file" ]; then
        return 0
    fi
    if ! grep -qE 'var __[A-Z0-9_]+_DEBUG__' "$file"; then
        return 0
    fi
    local tmp="${file}.debugpatch"
    sed -E \
        -e 's/(var __[A-Z0-9_]+_DEBUG__ = )false/\1true/g' \
        -e 's/(var __[A-Z0-9_]+_DEBUG__)=!1/\1=!0/g' \
        "$file" >"$tmp" && mv "$tmp" "$file"
}

# Cache entries track source checksums per mode (.build-cache-0 / .build-cache-1).
# Built JS artifacts are stored separately in .build-artifacts-0 / .build-artifacts-1.
cache_key_for_source() {
    local source_file="$1"
    get_file_checksum "$source_file"
}

artifact_path_for_target() {
    local target_file="$1"
    local relative_path="${target_file#$TARGET_BASE/}"
    echo "$ARTIFACT_DIR/$relative_path"
}

save_artifact() {
    local target_file="$1"
    local artifact_file
    artifact_file=$(artifact_path_for_target "$target_file")
    mkdir -p "$(dirname "$artifact_file")"
    cp "$target_file" "$artifact_file"
}

restore_artifact() {
    local target_file="$1"
    local artifact_file
    artifact_file=$(artifact_path_for_target "$target_file")
    if [ ! -f "$artifact_file" ]; then
        return 1
    fi
    mkdir -p "$(dirname "$target_file")"
    cp "$artifact_file" "$target_file"
    return 0
}

# Function to check if file has changed since last build
file_has_changed() {
    local source_file="$1"
    local target_file="$2"

    # If force rebuild is enabled, always return true
    if [ "$FORCE_REBUILD" = true ]; then
        return 0
    fi

    # If target doesn't exist, file needs processing
    if [ ! -f "$target_file" ]; then
        return 0
    fi

    # Get current checksum
    local current_checksum
    current_checksum=$(cache_key_for_source "$source_file")

    # Get cached checksum
    local cached_checksum=""
    if [ -f "$CACHE_FILE" ]; then
        cached_checksum=$(grep "^$source_file:" "$CACHE_FILE" | cut -d':' -f2-)
    fi

    # Compare checksums
    if [ "$current_checksum" != "$cached_checksum" ]; then
        return 0 # File has changed
    fi

    # Source unchanged for this mode — reuse saved artifact when available.
    local artifact_file
    artifact_file=$(artifact_path_for_target "$target_file")
    if [ ! -f "$artifact_file" ]; then
        return 0
    fi

    return 1 # File unchanged
}

# Function to update cache with file checksum and persist built output for this mode
update_cache() {
    local source_file="$1"
    local target_file="${2:-}"
    local checksum
    checksum=$(cache_key_for_source "$source_file")

    # Create cache file if it doesn't exist
    touch "$CACHE_FILE"

    # Remove old entry if exists
    if [ -f "$CACHE_FILE" ]; then
        grep -v "^$source_file:" "$CACHE_FILE" >"$CACHE_FILE.tmp" || true
        mv "$CACHE_FILE.tmp" "$CACHE_FILE"
    fi

    # Add new entry
    echo "$source_file:$checksum" >>"$CACHE_FILE"

    if [ -n "$target_file" ] && [ -f "$target_file" ]; then
        save_artifact "$target_file"
    fi
}

# Function to clean up orphaned files (files that exist in target but not in source)
cleanup_orphaned_files() {
    local source_dir="$1"
    local target_dir="$2"
    local dir_name="$3"

    if [ ! -d "$source_dir" ] || [ ! -d "$target_dir" ]; then
        return 0
    fi

    echo "Cleaning up orphaned files in $dir_name..."

    # Find all JS files in target directory
    find "$target_dir" -name "*.js" -type f | while IFS= read -r target_file; do
        local relative_path="${target_file#$target_dir/}"
        local source_file=""

        # Map target file back to source file location
        if [[ "$relative_path" == base/* ]]; then
            # Files in base folder come from root level of source
            source_file="$source_dir/${relative_path#base/}"
        else
            # Files in subdirectories
            source_file="$source_dir/$relative_path"
        fi

        # If corresponding source file doesn't exist, remove the target file
        if [ ! -f "$source_file" ]; then
            echo "  🗑 Removing orphaned file: $relative_path"
            rm -f "$target_file"

            # Also remove from cache and artifact store if present
            if [ -f "$CACHE_FILE" ]; then
                grep -v "^$source_file:" "$CACHE_FILE" >"$CACHE_FILE.tmp" || true
                mv "$CACHE_FILE.tmp" "$CACHE_FILE"
            fi
            if [ -n "$source_file" ]; then
                local artifact_file
                artifact_file=$(artifact_path_for_target "$target_file")
                rm -f "$artifact_file"
            fi
        fi
    done

    # Remove empty directories
    find "$target_dir" -type d -empty -delete || true
}

# Function to copy file only if it doesn't exist in target or has changed
copy_if_needed() {
    local source_file="$1"
    local target_file="$2"
    local target_dir=$(dirname "$target_file")

    # Create target directory if it doesn't exist
    mkdir -p "$target_dir"

    # If target doesn't exist, copy it
    if [ ! -f "$target_file" ]; then
        cp "$source_file" "$target_file"
        return 0
    fi

    # If force rebuild is enabled, always copy
    if [ "$FORCE_REBUILD" = true ]; then
        cp "$source_file" "$target_file"
        return 0
    fi

    # Check if source file has changed
    if file_has_changed "$source_file" "$target_file"; then
        cp "$source_file" "$target_file"
        return 0
    fi

    # File hasn't changed, don't copy
    return 1
}

# Function to copy directory structure intelligently
copy_directory_structure() {
    local source_dir="$1"
    local target_dir="$2"
    local dir_name="$3"

    if [ ! -d "$source_dir" ]; then
        return 0
    fi

    echo "Copying $dir_name structure..."

    # Create target directory
    mkdir -p "$target_dir"

    # Copy directory structure (non-JS files and directories)
    find "$source_dir" -type d | while IFS= read -r dir; do
        local relative_dir="${dir#$source_dir/}"
        if [ "$relative_dir" != "$dir" ]; then # Skip the root directory
            mkdir -p "$target_dir/$relative_dir"
        fi
    done

    # Copy non-JS files
    find "$source_dir" -type f ! -name "*.js" | while IFS= read -r file; do
        local relative_file="${file#$source_dir/}"
        copy_if_needed "$file" "$target_dir/$relative_file"
    done

    # Create base directory
    mkdir -p "$target_dir/base"

    # Handle JS files
    find "$source_dir" -maxdepth 1 -name "*.js" -type f | while IFS= read -r js_file; do
        local filename=$(basename "$js_file")
        local target_file="$target_dir/base/$filename"

        if copy_if_needed "$js_file" "$target_file"; then
            echo "  Copied $(basename "$js_file") to base folder"
        fi
    done

    # Handle JS files in subdirectories
    find "$source_dir" -mindepth 2 -name "*.js" -type f | while IFS= read -r js_file; do
        local relative_file="${js_file#$source_dir/}"
        local target_file="$target_dir/$relative_file"

        if copy_if_needed "$js_file" "$target_file"; then
            echo "  Copied $relative_file"
        fi
    done

    # Remove disabled files
    find "$target_dir" -name "*.disabled" -delete || true
}
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

    # Check for npx command once per folder (we may still copy files without transpilation)
    local HAS_NPX=1
    if ! command -v npx &>/dev/null; then
        HAS_NPX=0
        echo "  Warning: npx not found. Will copy without transpile/minify for $folder_name" >&2
    fi

    # Process each JS file in the folder
    echo "$js_files" | while IFS= read -r js_file; do
        local filename=$(basename "$js_file")

        # Find corresponding source file to check for changes
        local source_file=""
        local relative_path="${js_file#$TARGET_BASE/}"

        # Determine source file path based on target location
        if [[ "$relative_path" == scripts-priority/* ]]; then
            local sub_path="${relative_path#scripts-priority/}"
            # Handle base folder mapping (base/file.js -> file.js)
            if [[ "$sub_path" == base/* ]]; then
                source_file="$SOURCE_SCRIPTS_PRIORITY/${sub_path#base/}"
            else
                source_file="$SOURCE_SCRIPTS_PRIORITY/$sub_path"
            fi
        elif [[ "$relative_path" == scripts-post/* ]]; then
            local sub_path="${relative_path#scripts-post/}"
            # Handle base folder mapping (base/file.js -> file.js)
            if [[ "$sub_path" == base/* ]]; then
                source_file="$SOURCE_SCRIPTS_POST/${sub_path#base/}"
            else
                source_file="$SOURCE_SCRIPTS_POST/$sub_path"
            fi
        elif [[ "$relative_path" == scripts/* ]]; then
            local sub_path="${relative_path#scripts/}"
            # Handle base folder mapping (base/file.js -> file.js)
            if [[ "$sub_path" == base/* ]]; then
                source_file="$SOURCE_SCRIPTS/${sub_path#base/}"
            else
                source_file="$SOURCE_SCRIPTS/$sub_path"
            fi
        fi

        # Check skip-transform directive
        local skip_transform=0
        if head -n 5 "$js_file" | grep -q "@polyfills-prebuilt: skip-transform"; then
            skip_transform=1
        fi

        # Check if file has changed (restore cached artifact when unchanged)
        if [ -n "$source_file" ] && ! file_has_changed "$source_file" "$js_file"; then
            if restore_artifact "$js_file"; then
                echo "  ↻ Restored: $filename (artifact cache)"
            else
                echo "  ↻ Unchanged: $filename (skipped)"
            fi
            continue
        fi

        if [ "$skip_transform" -eq 1 ]; then
            if [ "$HAS_NPX" -eq 1 ]; then
                # Prebuilt: transpile to iOS 8 using project config in PREBUILT mode, then minify
                local temp_js_transpiled
                local temp_js_minified
                temp_js_transpiled=$(mktemp)
                temp_js_minified=$(mktemp)

                local UGLIFY_ARGS
                UGLIFY_ARGS=(--mangle -o "$temp_js_minified")
                if [ "$filename" != "A_start.js" ]; then
                    UGLIFY_ARGS=(--compress "$UGLIFY_COMPRESS" "${UGLIFY_ARGS[@]}")
                fi

                trap 'rm -f "$temp_js_transpiled" "$temp_js_minified"; trap - RETURN EXIT INT TERM' RETURN EXIT INT TERM

                if BABEL_ENV=prebuilt npx babel "$js_file" -o "$temp_js_transpiled"; then
                    apply_debug_flags "$temp_js_transpiled"
                    if npx uglifyjs "$temp_js_transpiled" "${UGLIFY_ARGS[@]}"; then
                        cp "$temp_js_minified" "$js_file"
                        echo "  ✓ ES5 + minified: $filename (prebuilt iOS8)"
                    else
                        cp "$temp_js_transpiled" "$js_file"
                        echo "  ⚠ ES5 only: $filename (uglify failed)"
                    fi
                elif npx babel "$js_file" --no-babelrc --plugins @babel/plugin-transform-arrow-functions -o "$temp_js_transpiled"; then
                    apply_debug_flags "$temp_js_transpiled"
                    if npx uglifyjs "$temp_js_transpiled" "${UGLIFY_ARGS[@]}"; then
                        cp "$temp_js_minified" "$js_file"
                        echo "  ✓ ES5 + minified: $filename (prebuilt, arrows->functions)"
                    else
                        cp "$temp_js_transpiled" "$js_file"
                        echo "  ⚠ ES5 only: $filename (uglify failed)"
                    fi
                else
                    # Fallback: minify only
                    if npx uglifyjs "$js_file" "${UGLIFY_ARGS[@]}"; then
                        cp "$temp_js_minified" "$js_file"
                        echo "  ✓ Minified only: $filename (prebuilt, no babel plugins)"
                    else
                        echo "  ⚠ Skipped transforms: $filename (prebuilt, no babel/uglify)"
                    fi
                fi
                # Update cache if we have source file
                if [ -n "$source_file" ]; then
                    update_cache "$source_file" "$js_file"
                fi
            else
                # No npx, leave file as-is but update cache
                echo "  ⤴ Skipped transforms: $filename (prebuilt, no npx)"
                if [ -n "$source_file" ]; then
                    update_cache "$source_file" "$js_file"
                fi
            fi
        elif [ "$HAS_NPX" -eq 0 ]; then
            echo "  ⤴ Skipped transforms: $filename (no npx)"
            if [ -n "$source_file" ]; then
                update_cache "$source_file" "$js_file"
            fi
        else
            local temp_js_transpiled
            local temp_js_minified

            temp_js_transpiled=$(mktemp)
            temp_js_minified=$(mktemp)

            local UGLIFY_ARGS
            UGLIFY_ARGS=(--mangle -o "$temp_js_minified")
            if [ "$filename" != "A_start.js" ]; then
                UGLIFY_ARGS=(--compress "$UGLIFY_COMPRESS" "${UGLIFY_ARGS[@]}")
            fi

            # Local trap for temp files
            trap 'rm -f "$temp_js_transpiled" "$temp_js_minified"; trap - RETURN EXIT INT TERM' RETURN EXIT INT TERM

            # Transpile with Babel
            if npx babel "$js_file" -o "$temp_js_transpiled"; then
                apply_debug_flags "$temp_js_transpiled"
                # Minify with UglifyJS
                if npx uglifyjs "$temp_js_transpiled" "${UGLIFY_ARGS[@]}"; then
                    cp "$temp_js_minified" "$js_file"
                    echo "  ✓ Processed: $filename (transpiled + minified)"

                    # Update cache if we have source file
                    if [ -n "$source_file" ]; then
                        update_cache "$source_file" "$js_file"
                    fi
                else
                    # Minification failed, use transpiled version
                    cp "$temp_js_transpiled" "$js_file"
                    echo "  ⚠ Transpiled only: $filename (minification failed)"

                    # Update cache if we have source file
                    if [ -n "$source_file" ]; then
                        update_cache "$source_file" "$js_file"
                    fi
                fi
            else
                echo "  ✗ Skipped: $filename (transpilation failed)"
                echo "1" >> "$BABEL_FAILURES_FILE"
            fi

            # Cleanup handled by trap
        fi
    done

    echo "  Completed processing $folder_name"
    return 0
}

# Create target directories
BABEL_FAILURES_FILE="${TARGET_BASE}/.babel-failures"
: > "$BABEL_FAILURES_FILE"
mkdir -p "$TARGET_BASE/scripts"
mkdir -p "$TARGET_BASE/scripts-post"
mkdir -p "$TARGET_BASE/scripts-priority"

# Copy directory structures intelligently
copy_directory_structure "$SOURCE_SCRIPTS" "$TARGET_BASE/scripts" "scripts"
copy_directory_structure "$SOURCE_SCRIPTS_PRIORITY" "$TARGET_BASE/scripts-priority" "scripts-priority"
copy_directory_structure "$SOURCE_SCRIPTS_POST" "$TARGET_BASE/scripts-post" "scripts-post"

# Clean up orphaned files (files that were moved or deleted from source)
cleanup_orphaned_files "$SOURCE_SCRIPTS" "$TARGET_BASE/scripts" "scripts"
cleanup_orphaned_files "$SOURCE_SCRIPTS_PRIORITY" "$TARGET_BASE/scripts-priority" "scripts-priority"
cleanup_orphaned_files "$SOURCE_SCRIPTS_POST" "$TARGET_BASE/scripts-post" "scripts-post"

echo ""
echo "Building and optimizing JavaScript files with Babel and UglifyJS..."

# Process all folders in scripts directory (excluding root level)
if [ -d "$TARGET_BASE/scripts" ]; then
    find "$TARGET_BASE/scripts" -mindepth 1 -type d | while IFS= read -r folder; do
        process_js_folder "$folder"
    done
fi

# Process all folders in scripts-priority directory (excluding root level)
if [ -d "$TARGET_BASE/scripts-priority" ]; then
    find "$TARGET_BASE/scripts-priority" -mindepth 1 -type d | while IFS= read -r folder; do
        process_js_folder "$folder"
    done
fi

# Process all folders in scripts-post directory (excluding root level)
if [ -d "$TARGET_BASE/scripts-post" ]; then
    find "$TARGET_BASE/scripts-post" -mindepth 1 -type d | while IFS= read -r folder; do
        process_js_folder "$folder"
    done
fi

echo ""
if [ "$FORCE_REBUILD" = true ]; then
    echo "Force rebuild completed. All JavaScript files have been transpiled and minified."
else
    echo "Incremental build completed. Only changed JavaScript files were processed."
fi
echo "Optimized structure created at: $TARGET_BASE"
echo "Build cache stored at: $CACHE_FILE"
echo "Artifact cache stored at: $ARTIFACT_DIR"

if [ -s "$BABEL_FAILURES_FILE" ]; then
    rm -f "$BABEL_FAILURES_FILE"
    echo "Build failed: one or more JavaScript files could not be transpiled."
    exit 1
fi
rm -f "$BABEL_FAILURES_FILE"
