/*
 * Polyfills Tweak - Filesystem-based JavaScript injection with async loading
 *
 * This tweak loads JavaScript polyfills dynamically from the filesystem
 * instead of embedding them in header files. This allows for easier
 * management and user customization of polyfills.
 *
 * Performance: Scripts are loaded asynchronously at tweak initialization
 * and cached in memory for fast injection into WKWebViews.
 *
 * Directory structure: /Library/Application Support/Polyfills/
 * ├── scripts/                    # Injected at document start
 * │   ├── base/                   # Base scripts for all iOS versions
 * │   ├── 9.0/                   # Scripts for iOS < 9.0
 * │   ├── 10.0/                  # Scripts for iOS < 10.0
 * │   └── ...                    # Other version directories (auto-discovered)
 * └── scripts-post/               # Injected at document end
 *     ├── base/                   # Base post-scripts for all iOS versions
 *     └── 15.4/, 16.4/           # Version-specific post-scripts (auto-discovered)
 *
 * JavaScript files (.js) in each directory are loaded alphabetically.
 * Version directories are auto-discovered and sorted in ascending order.
 * Version-specific directories are only loaded if the current iOS
 * version is older than the directory version.
 */

#define CHECK_TARGET
#import <HBLog.h>
#import <PSHeader/PS.h>
#import <WebKit/WebKit.h>
#import <theos/IOSMacros.h>
#import <version.h>
#import "Header.h"

BOOL userAgentEnabled = NO;

@interface _SFReloadOptionsController : NSObject
@end

static BOOL isIOSVersionOrNewer(NSInteger major, NSInteger minor) {
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    if (version.majorVersion > major) return YES;
    if (version.majorVersion == major && version.minorVersion >= minor) return YES;
    return NO;
}

// Helper function to load JavaScript content from a file
static NSString *loadJSFromFile(NSString *filePath) {
    if (![[NSFileManager defaultManager] fileExistsAtPath:filePath]) {
        HBLogDebug(@"Polyfills: JS file not found at path: %@", filePath);
        return nil;
    }

    NSError *error;
    NSString *content = [NSString stringWithContentsOfFile:filePath encoding:NSUTF8StringEncoding error:&error];
    if (error) {
        HBLogDebug(@"Polyfills: Error reading JS file %@: %@", filePath, error.localizedDescription);
        return nil;
    }

    return content;
}

// Helper function to concatenate all JS files in a directory
static NSString *loadJSFromDirectory(NSString *directoryPath) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:directoryPath]) {
        HBLogDebug(@"Polyfills: Directory not found at path: %@", directoryPath);
        return @"";
    }

    NSError *error;
    NSArray *files = [fileManager contentsOfDirectoryAtPath:directoryPath error:&error];
    if (error) {
        HBLogDebug(@"Polyfills: Error reading directory %@: %@", directoryPath, error.localizedDescription);
        return @"";
    }

    // Filter for .js files and sort them
    NSArray *jsFiles = [[files filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"pathExtension == 'js'"]]
                       sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)];

    NSMutableString *combinedScript = [NSMutableString string];
    // Load user preferences once per directory load
    CFArrayRef disabledScripts = (CFArrayRef)CFPreferencesCopyAppValue(disabledScriptsKey, domain);
    NSSet *disabledSet = nil;
    if (disabledScripts && CFGetTypeID(disabledScripts) == CFArrayGetTypeID()) {
        NSArray *arr = (__bridge NSArray *)disabledScripts;
        NSMutableArray *lower = [NSMutableArray arrayWithCapacity:arr.count];
        for (id obj in arr) {
            if ([obj isKindOfClass:[NSString class]]) {
                [lower addObject:[(NSString *)obj lowercaseString]];
            }
        }
        if (lower.count) disabledSet = [NSSet setWithArray:lower];
    }
    if (disabledScripts) CFRelease(disabledScripts);

    for (NSString *fileName in jsFiles) {
        if (disabledSet && [disabledSet containsObject:fileName.lowercaseString]) continue;
        NSString *filePath = [directoryPath stringByAppendingPathComponent:fileName];
        NSString *content = loadJSFromFile(filePath);
        if (!content) continue;
        if ([fileName isEqualToString:@"Navigator.hardwareConcurrency.js"]) {
            NSInteger coreCount = [[NSProcessInfo processInfo] processorCount];
            NSInteger clamped = (coreCount <= 2) ? 2 : (coreCount <= 4) ? 4 : (coreCount <= 6) ? 6 : 8;
            NSString *js = [NSString stringWithFormat:@"window.__injectedHardwareConcurrency__ = %ld;", (long)clamped];
            content = [js stringByAppendingString:content];
        }
        // Wrap every script with a guard that consults window.__pfShouldRun(scriptName)
        NSString *wrapped = [NSString stringWithFormat:@"(function(n){try{if(window.__pfShouldRun && !window.__pfShouldRun(n)) return;}catch(e){}\n%@\n})(\"%@\");\n", content, fileName];
        [combinedScript appendString:wrapped];
    }

    return [combinedScript copy];
}

// Helper function to get base polyfills directory path
static NSString *getPolyfillsBasePath() {
    return PS_ROOT_PATH_NS(@"/Library/Application Support/Polyfills");
}

// Global variables for script loading
static dispatch_queue_t scriptLoadingQueue;

// Helper function to load scripts for a specific iOS version or older
// If injectionCallback is provided, scripts are injected immediately as they're loaded
static NSString *loadScriptsForIOSVersion(NSString *basePath, NSString *scriptsDir, void (^injectionCallback)(NSString *script, BOOL isPost)) {
    NSString *fullBasePath = [basePath stringByAppendingPathComponent:scriptsDir];
    BOOL isPost = [scriptsDir hasSuffix:@"-post"];

    NSMutableString *combinedScripts = [NSMutableString string];

    // Load base scripts (always included)
    NSString *baseScriptsPath = [fullBasePath stringByAppendingPathComponent:@"base"];
    NSString *baseScripts = loadJSFromDirectory(baseScriptsPath);
    if (baseScripts.length > 0) {
        if (injectionCallback) {
            injectionCallback(baseScripts, isPost);
        }
        [combinedScripts appendString:baseScripts];
        [combinedScripts appendString:@"\n"];
    }

    // Dynamically discover version directories
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSError *error;
    NSArray *allItems = [fileManager contentsOfDirectoryAtPath:fullBasePath error:&error];
    if (error) {
        HBLogDebug(@"Polyfills: Error reading scripts directory %@: %@", fullBasePath, error.localizedDescription);
        return [combinedScripts copy];
    }

    // Filter for version directories (directories that match version pattern like "9.0", "10.1", etc.)
    NSMutableArray *versionDirs = [NSMutableArray array];
    NSRegularExpression *versionRegex = [NSRegularExpression regularExpressionWithPattern:@"^\\d+\\.\\d+$" options:0 error:nil];

    for (NSString *item in allItems) {
        NSString *itemPath = [fullBasePath stringByAppendingPathComponent:item];
        BOOL isDirectory;
        if ([fileManager fileExistsAtPath:itemPath isDirectory:&isDirectory] && isDirectory) {
            if ([versionRegex numberOfMatchesInString:item options:0 range:NSMakeRange(0, item.length)] > 0) {
                [versionDirs addObject:item];
            }
        }
    }

    // Sort version directories in ascending order (9.0, 10.0, 10.1, etc.)
    [versionDirs sortUsingComparator:^NSComparisonResult(NSString *version1, NSString *version2) {
        NSArray *components1 = [version1 componentsSeparatedByString:@"."];
        NSArray *components2 = [version2 componentsSeparatedByString:@"."];

        NSInteger major1 = [components1[0] integerValue];
        NSInteger major2 = [components2[0] integerValue];

        if (major1 != major2) {
            return major1 < major2 ? NSOrderedAscending : NSOrderedDescending;
        }

        NSInteger minor1 = components1.count > 1 ? [components1[1] integerValue] : 0;
        NSInteger minor2 = components2.count > 1 ? [components2[1] integerValue] : 0;

        if (minor1 != minor2) {
            return minor1 < minor2 ? NSOrderedAscending : NSOrderedDescending;
        }

        return NSOrderedSame;
    }];

    // Load scripts from version directories if current iOS version is older
    for (NSString *versionStr in versionDirs) {
        NSArray *components = [versionStr componentsSeparatedByString:@"."];
        NSInteger vMajor = [components[0] integerValue];
        NSInteger vMinor = components.count > 1 ? [components[1] integerValue] : 0;

        // If current iOS version is less than this polyfill version, include it
        if (isIOSVersionOrNewer(vMajor, vMinor)) continue;
        NSString *versionPath = [fullBasePath stringByAppendingPathComponent:versionStr];
        NSString *versionScripts = loadJSFromDirectory(versionPath);
        if (versionScripts.length > 0) {
            if (injectionCallback) {
                injectionCallback(versionScripts, isPost);
            }
            [combinedScripts appendString:versionScripts];
            [combinedScripts appendString:@"\n"];
        }
    }

    return [combinedScripts copy];
}

static NSString *mobileUserAgent = @"Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1.36";
static NSString *desktopUserAgent = @"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15";

static NSString *getFinalUA(NSString *defaultUA) {
    NSString *finalUA = defaultUA;
    NSString *spoofedVersion = @"16_3";
    NSString *spoofedSafariVersion = @"Version/16.3";
    NSError *regexError = nil;
    // Capture major & minor (ignore patch) from "OS major_minor(_patch)" pattern
    NSRegularExpression *osCaptureRegex = [NSRegularExpression regularExpressionWithPattern:@"OS (\\d+?)_(\\d+)(?:_\\d+)?" options:0 error:&regexError];
    if (regexError) {
        HBLogDebug(@"Polyfills Regex error: %@", regexError.localizedDescription);
        return finalUA;
    }

    NSTextCheckingResult *match = [osCaptureRegex firstMatchInString:finalUA options:0 range:NSMakeRange(0, finalUA.length)];
    BOOL shouldSpoof = NO;
    if (match.numberOfRanges >= 3) {
        NSString *majorStr = [finalUA substringWithRange:[match rangeAtIndex:1]];
        NSString *minorStr = [finalUA substringWithRange:[match rangeAtIndex:2]];
        NSInteger major = majorStr.integerValue;
        NSInteger minor = minorStr.integerValue;
        if (major < 16 || (major == 16 && minor < 3)) {
            shouldSpoof = YES;
        }
    }

    if (shouldSpoof) {
        // Replace the OS version fragment
        NSRegularExpression *osReplaceRegex = [NSRegularExpression regularExpressionWithPattern:@"OS \\d+_\\d+(?:_\\d+)?" options:0 error:nil];
        finalUA = [osReplaceRegex stringByReplacingMatchesInString:finalUA options:0 range:NSMakeRange(0, finalUA.length) withTemplate:[NSString stringWithFormat:@"OS %@", spoofedVersion]];
        // Keep Safari version spoof tied to OS spoof to avoid inconsistencies
        NSRegularExpression *versionRegex = [NSRegularExpression regularExpressionWithPattern:@"Version/\\d+(\\.\\d+)*" options:0 error:nil];
        finalUA = [versionRegex stringByReplacingMatchesInString:finalUA options:0 range:NSMakeRange(0, finalUA.length) withTemplate:spoofedSafariVersion];
    }
    finalUA = [finalUA stringByReplacingOccurrencesOfString:@"iPod touch" withString:@"iPhone"];
    return finalUA;
}

static void setUserAgent(WKWebView *webView, NSString *userAgent) {
    if (!userAgent) return;
    if ([webView respondsToSelector:@selector(setCustomUserAgent:)])
        webView.customUserAgent = userAgent;
    else {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults registerDefaults:@{@"UserAgent": userAgent}];
    }
}

static void overrideUserAgent(WKWebView *webView) {
    if (isIOSVersionOrNewer(16, 3) || !userAgentEnabled) return;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    WKContentMode contentMode = WKContentModeRecommended;
    if (isIOSVersionOrNewer(13, 0))
        contentMode = webView.configuration.defaultWebpagePreferences.preferredContentMode;
    NSString *ua = IS_IPAD || contentMode == WKContentModeDesktop ? desktopUserAgent : mobileUserAgent;
#pragma clang diagnostic pop
    setUserAgent(webView, ua);
}

// Function to load and inject scripts with optimized batching
static void loadAndInjectScriptsImmediately(WKUserContentController *controller) {
    NSString *polyfillsBasePath = getPolyfillsBasePath();

    // Load and inject scripts in batches to minimize WKUserScript overhead
    dispatch_async(scriptLoadingQueue, ^{
        @autoreleasepool {
            NSMutableString *combinedStartScripts = [NSMutableString string];
            NSMutableString *combinedEndScripts = [NSMutableString string];

            // Load priority scripts (document start)
            NSString *priorityScripts = loadScriptsForIOSVersion(polyfillsBasePath, @"scripts-priority", nil);
            if (priorityScripts.length > 0) {
                [combinedStartScripts appendString:priorityScripts];
                [combinedStartScripts appendString:@"\n"];
            }

            // Load main scripts (document start)
            NSString *mainScripts = loadScriptsForIOSVersion(polyfillsBasePath, @"scripts", nil);
            if (mainScripts.length > 0) {
                [combinedStartScripts appendString:mainScripts];
                [combinedStartScripts appendString:@"\n"];
            }

            // Load post scripts (document end)
            NSString *postScripts = loadScriptsForIOSVersion(polyfillsBasePath, @"scripts-post", nil);
            if (postScripts.length > 0) {
                [combinedEndScripts appendString:postScripts];
            }

            // Prepare per-site (and optional path) blacklist dictionary from preferences
            CFDictionaryRef blacklistPref = (CFDictionaryRef)CFPreferencesCopyAppValue(scriptBlacklistKey, domain);
            NSDictionary *blacklistDict = nil;
            if (blacklistPref && CFGetTypeID(blacklistPref) == CFDictionaryGetTypeID()) {
                blacklistDict = [(__bridge NSDictionary *)blacklistPref copy];
            }
            if (blacklistPref) CFRelease(blacklistPref);

            // Build prelude defining window.__pfShouldRun for blacklist enforcement.
            NSString *prelude = nil;
            if (blacklistDict.count) {
                NSData *jsonData = [NSJSONSerialization dataWithJSONObject:blacklistDict options:0 error:nil];
                NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
                if (!json) json = @"{}";
                NSMutableString *p = [NSMutableString string];
                [p appendString:@"(function(){\nvar __pfBL = "]; [p appendString:json]; [p appendString:@";\nwindow.__pfShouldRun = function(script){var orig=script;script=String(script||'').toLowerCase();var arr=__pfBL[script];if(!arr||!arr.length)return true;var h=location.hostname.toLowerCase();var path=location.pathname;for(var i=0;i<arr.length;i++){var e=String(arr[i]||'').toLowerCase();if(!e)continue;var slash=e.indexOf('/');if(slash<0){if(h===e||h.endsWith('.'+e)){try{console.log('[Polyfills] Skipped '+orig+' on '+location.host+' (domain '+e+')');}catch(_){ }return false;}}else{var host=e.substring(0,slash);var pref=e.substring(slash+1);if(h===host||h.endsWith('.'+host)){var prefPath='/' + pref.replace(/^\\/+/, '');if(path===prefPath||path.startsWith(prefPath+(prefPath.endsWith('/')?'':'/'))||path.startsWith(prefPath)){try{console.log('[Polyfills] Skipped '+orig+' on '+location.host+path+' (prefix '+e+')');}catch(_){ }return false;}}}}return true;};\n})();\n"];
                prelude = p;
            }

            // If there are only post scripts but no start scripts, attach prelude to post scripts.
            if (prelude) {
                if (combinedStartScripts.length > 0) {
                    [combinedStartScripts insertString:prelude atIndex:0];
                } else if (combinedEndScripts.length > 0) {
                    [combinedEndScripts insertString:prelude atIndex:0];
                }
            }

            // Inject combined scripts as single WKUserScript objects (each individual script wrapper checks blacklist)
            dispatch_async(dispatch_get_main_queue(), ^{
                if (combinedStartScripts.length > 0 && controller) {
                    NSString *source = [combinedStartScripts copy];
                    [controller addUserScript:[[WKUserScript alloc] initWithSource:source
                                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                                   forMainFrameOnly:NO]];
                    HBLogDebug(@"Polyfills: Injected combined start scripts (%lu chars)", (unsigned long)combinedStartScripts.length);
                }
                if (combinedEndScripts.length > 0 && controller) {
                    NSString *source = [combinedEndScripts copy];
                    [controller addUserScript:[[WKUserScript alloc] initWithSource:source
                                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                                                   forMainFrameOnly:NO]];
                    HBLogDebug(@"Polyfills: Injected combined end scripts (%lu chars)", (unsigned long)combinedEndScripts.length);
                }
            });
        }
    });
}

%hook WKWebView

static const void *InjectedKey = &InjectedKey;

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    WKUserContentController *controller = configuration.userContentController;
    if (!controller) {
        controller = [[WKUserContentController alloc] init];
        configuration.userContentController = controller;
    }
    if (!objc_getAssociatedObject(controller, InjectedKey)) {
        objc_setAssociatedObject(controller, InjectedKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

        // Always use immediate injection for best performance
        loadAndInjectScriptsImmediately(controller);
    }
    WKWebView *webView = %orig;
    overrideUserAgent(webView);
    return webView;
}

- (void)setCustomUserAgent:(NSString *)customUserAgent {
    HBLogDebug(@"Polyfills Setting custom user agent: %@", customUserAgent);
    %orig(userAgentEnabled ? getFinalUA(customUserAgent) : customUserAgent);
}

- (void)setApplicationNameForUserAgent:(NSString *)applicationNameForUserAgent {
    HBLogDebug(@"Polyfills Setting application name for user agent: %@", applicationNameForUserAgent);
    %orig(userAgentEnabled ? getFinalUA(applicationNameForUserAgent) : applicationNameForUserAgent);
}

%end

%group UserAgent

%hook NSMutableURLRequest

- (void)setValue:(NSString *)value forHTTPHeaderField:(NSString *)field {
    if ([field caseInsensitiveCompare:@"User-Agent"] == NSOrderedSame)
        value = IS_IPAD ? desktopUserAgent : mobileUserAgent;
    %orig(value, field);
}

%end

%hook _SFReloadOptionsController

- (void)didMarkURLAsNeedingDesktopUserAgent:(id)arg1 {
    HBLogDebug(@"Polyfills didMarkURLAsNeedingDesktopUserAgent called");
    WKWebView *webView = [self valueForKey:@"_webView"];
    if (webView) setUserAgent(webView, desktopUserAgent);
    %orig;
}

- (void)didMarkURLAsNeedingStandardUserAgent:(id)arg1 {
    HBLogDebug(@"Polyfills didMarkURLAsNeedingStandardUserAgent called");
    WKWebView *webView = [self valueForKey:@"_webView"];
    if (webView) setUserAgent(webView, mobileUserAgent);
    %orig;
}

%end

%end

%hook NSRegularExpression

- (void)enumerateMatchesInString:(NSString *)string options:(NSMatchingOptions)options range:(NSRange)range usingBlock:(void (^)(NSTextCheckingResult *result, NSMatchingFlags flags, BOOL *stop))block {
    if (!string) {
        HBLogDebug(@"Polyfills: Skipping regex match enumeration for empty string");
        return;
    }
    %orig(string, options, range, block);
}

%end

%ctor {
    if (!isTarget(TargetTypeApps)) return;
    Boolean keyExists;
    Boolean enabled = CFPreferencesGetAppBooleanValue(key, domain, &keyExists);
    if (!keyExists ? NO : !enabled) return;

    // Create queue for async script loading
    scriptLoadingQueue = dispatch_queue_create("com.polyfills.scriptloading", DISPATCH_QUEUE_SERIAL);

    %init;

    if (!isIOSVersionOrNewer(16, 3) && CFPreferencesGetAppBooleanValue(userAgentKey, domain, NULL)) {
        userAgentEnabled = YES;
        %init(UserAgent);
    }
}
