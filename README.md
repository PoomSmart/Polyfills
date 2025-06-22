# Polyfills

Provides JavaScript polyfills (and fixes) for Mobile Safari and WebKit-based views on iOS.

## Description

This tweak injects JavaScript polyfills to enhance web compatibility for older iOS versions. It targets Mobile Safari, Safari View Services, and general WebKit views.

The JavaScript polyfills can be found in `/scripts` and `/scripts-post` folders.

The scripts under `/scripts` are injected at [the document start](https://developer.apple.com/documentation/webkit/wkuserscriptinjectiontime/atdocumentstart?language=objc), while those in `/scripts-post` are injected after [the document has loaded](https://developer.apple.com/documentation/webkit/wkuserscriptinjectiontime/atdocumentend?language=objc).

The scripts may be put under a folder named after the specific iOS version, such as `15.0`. The scripts inside that folder will only be injected when the device iOS version is **no more than** the version specified in the folder name. That is, they will run under iOS 14.8 and earlier.

## Requirements

- iOS 8.0 or later

## Installation

1. Build the project using Theos.
2. Install the resulting `.deb` package on your jailbroken iOS device.

# Building

```sh
npm install
./build-scripts.sh   # Build and optimize JavaScript polyfills
make headers
make
```

The build script transpiles and minifies all JavaScript files for optimal package size and runtime performance.

# Will it fix XXX website?

TL;DR: Depends.

If the website uses modern JavaScript features or APIs that are not supported by the iOS version you are using, this tweak will help polyfill those features. However, it may not cover every single case, especially if the website relies on very recent web standards or APIs that cannot be remedied with JavaScript alone.

# Additional Notes

Check out the [WKExperimentalFeatures.md](WKExperimentalFeatures.md) file for recommended WebKit experimental features to enable to enhance web compatibility further.
