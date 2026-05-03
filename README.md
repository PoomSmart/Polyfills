# Polyfills

Provides JavaScript polyfills (and fixes) for Mobile Safari and WebKit-based views on iOS.

## Description

This tweak injects JavaScript polyfills to enhance web compatibility for older iOS versions. It targets Mobile Safari, Safari View Services, and general WebKit views.

The JavaScript polyfills can be found in `/scripts`, `/scripts-priority` and `/scripts-post` folders.

The scripts under `/scripts` are injected at [the document start](https://developer.apple.com/documentation/webkit/wkuserscriptinjectiontime/atdocumentstart?language=objc). The scripts under `/scripts-post` are injected after [the document has loaded](https://developer.apple.com/documentation/webkit/wkuserscriptinjectiontime/atdocumentend?language=objc). The scripts under `/scripts-priority` are injected at document start, but with a higher priority than those in `/scripts`. This is useful for polyfills that need to be applied before any other scripts run.

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
make
```

The build script transpiles and minifies all JavaScript files for optimal package size and runtime performance.

# Will it fix XXX website?

TL;DR: Depends.

If the website uses modern JavaScript features or APIs that are not supported by the iOS version you are using, this tweak will help polyfill those features. However, it may not cover every single case, especially if the website relies on very recent web standards or APIs that cannot be remedied with JavaScript alone.

# Additional Notes

Check out the [WKExperimentalFeatures.md](WKExperimentalFeatures.md) file for recommended WebKit experimental features to enable to enhance web compatibility further.

## Alternative: Gecko-based Browser

Polyfills can only do so much — some web standards cannot be implemented in JavaScript alone (e.g. CSS features, certain media codecs, or APIs with no JS surface). If you find that websites still don't work correctly on your older iOS device, consider using [Reynard Browser](https://github.com/minh-ton/reynard-browser), a Gecko-based mobile web browser for iOS 14+. Since it runs Firefox's Gecko engine instead of WebKit, it has much broader and more up-to-date web platform support out of the box.
