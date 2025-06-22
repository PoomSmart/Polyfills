# Filesystem-Based Polyfills

## Build Process

The build script (`build-scripts.sh`) processes JavaScript polyfills for optimal packaging:

1. **File Organization**: Copies and organizes scripts from source directories
2. **Base Script Handling**: Moves all root-level `.js` files to `base/` folders automatically
3. **Optimization**: Transpiles with Babel and minifies with UglifyJS for smaller package size
4. **Performance**: Processes files per folder for efficient build times

**Requirements**: Node.js and npm must be installed for transpilation and minification. If npx is not available, files will be copied without optimization.

## Directory Structure

The tweak loads JavaScript files from `/Library/Application Support/Polyfills/` with the following structure:

```
/Library/Application Support/Polyfills/
├── scripts/                    # Scripts injected at document start
│   ├── base/                   # Base scripts loaded for all iOS versions
│   │   └── *.js                # JavaScript files (loaded alphabetically)
│   ├── 15.4/                   # Scripts for iOS versions < 15.4
│   ├── 16.4/                   # Scripts for iOS versions < 16.4
|   ├── ...
└── scripts-post/               # Scripts injected at document end
    ├── base/                   # Base post-scripts loaded for all iOS versions
    ├── 15.4/                   # Post-scripts for iOS versions < 15.4
    └── 16.4/                   # Post-scripts for iOS versions < 16.4
    └── ...
```

## How It Works

1. **Async Initialization**: When the tweak loads, it:
   - Creates a background queue for script loading
   - Starts loading all JavaScript files asynchronously
   - Caches the combined scripts in memory for fast access

2. **Runtime Injection**: When a `WKWebView` is initialized, the tweak:
   - **Base Scripts**: Files in `scripts/base/` and `scripts-post/base/` are loaded for all iOS versions
   - **Version-Specific Scripts**: Files in version directories (e.g., `scripts/10.0/`) are only loaded if the current iOS version is older than that version
   - **Fast Injection**: Uses cached scripts if available, or waits briefly for async loading
   - **Fallback**: Falls back to synchronous loading if async loading is slow

3. **File Loading**: JavaScript files (`.js`) in each directory are loaded alphabetically
4. **Injection Timing**:
   - `scripts/` files are injected at document start
   - `scripts-post/` files are injected at document end

## Adding New Polyfills

To add a new polyfill:

1. Create a `.js` file in the appropriate version directory
2. For polyfills needed on all iOS versions, place them in the `base/` directory
3. For version-specific polyfills, place them in the corresponding version directory
4. Files are loaded alphabetically, so prefix with numbers if order matters (e.g., `01-feature.js`, `02-other.js`)

**Requirements**: The build script requires Node.js and npm to be installed for transpilation and minification. If npx is not available, files will be copied without optimization.

## Debugging

The tweak logs information about loaded files to the console:
- Files not found: `Polyfills: JS file not found at path: ...`
- Directory read errors: `Polyfills: Error reading directory ...`
- File read errors: `Polyfills: Error reading JS file ...`

Use a console app or device logs to monitor loading behavior.
