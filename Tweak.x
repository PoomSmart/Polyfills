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
 * Injection order (each step is one WKUserScript bundle per injection time):
 *   Document start: blacklist bootstrap → scripts-priority → scripts
 *   Document end:   blacklist bootstrap (only if start bundle empty) → scripts-post
 *
 * Blacklist bootstrap = runtime `window.__pfBL` JSON (from prefs) + A_blacklist.js.
 * Each polyfill file is wrapped with a __pfShouldRun(name) guard in Tweak.x.
 */

#define CHECK_TARGET
#import <HBLog.h>
#import <PSHeader/PS.h>
#import <WebKit/WebKit.h>
#import <theos/IOSMacros.h>
#import <version.h>
#import "Header.h"

BOOL userAgentEnabled = NO;
static const void *PendingUserAgentURLKey = &PendingUserAgentURLKey;

@interface _SFReloadOptionsController : NSObject
@end

static BOOL isIOSVersionOrNewer(NSInteger major, NSInteger minor) {
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    if (version.majorVersion > major) return YES;
    if (version.majorVersion == major && version.minorVersion >= minor) return YES;
    return NO;
}

static BOOL isUserAgentBlacklistedForURL(NSURL *url) {
    if (url != nil) {
        NSString *scheme = [url.scheme lowercaseString];
        if (scheme && ![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) {
            return YES;
        }
    }
    NSArray<NSString *> *blacklist = [PolyfillsBlacklistManager mergedUserAgentBlacklist];
    if (url == nil || blacklist.count == 0) return NO;
    for (NSString *entry in blacklist) {
        if (PFDomainPathMatchesURL(entry, url)) {
            return YES;
        }
    }
    return NO;
}

static NSURL *currentUserAgentURL(WKWebView *webView, NSURL *fallbackURL) {
    if (fallbackURL != nil) {
        NSString *scheme = [fallbackURL.scheme lowercaseString];
        if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) {
            return fallbackURL;
        }
    }
    if (webView != nil) {
        NSURL *webURL = webView.URL;
        if (webURL != nil) {
            NSString *scheme = [webURL.scheme lowercaseString];
            if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) {
                return webURL;
            }
        }
        NSURL *pending = objc_getAssociatedObject(webView, PendingUserAgentURLKey);
        if (pending != nil) {
            NSString *scheme = [pending.scheme lowercaseString];
            if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) {
                return pending;
            }
        }
    }
    return fallbackURL ?: (webView ? webView.URL : nil);
}

static void rememberPendingUserAgentURL(WKWebView *webView, NSURL *url) {
    if (webView == nil) return;
    objc_setAssociatedObject(webView,
                             PendingUserAgentURLKey,
                             url,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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

// Helper function to escape a filename for safe embedding in generated JS
static NSString *jsEscapedString(NSString *string) {
    if (!string) return @"\"\"";
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[string] options:0 error:nil];
    if (!data) return @"\"\"";
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (json.length >= 2) {
        return [json substringWithRange:NSMakeRange(1, json.length - 2)];
    }
    return @"\"\"";
}

// Global variables for script loading
static dispatch_queue_t scriptLoadingQueue;
static NSString *cachedCombinedStartScripts = nil;
static NSString *cachedCombinedEndScripts = nil;

// Cached disabled-script set; rebuilt when preferences change.
static NSSet *cachedDisabledScripts = nil;

static NSSet *disabledScriptsSet(void) {
    if (cachedDisabledScripts) return cachedDisabledScripts;
    CFArrayRef disabledScripts = (CFArrayRef)CFPreferencesCopyAppValue(disabledScriptsKey, domain);
    NSMutableSet *disabledSet = [NSMutableSet set];
    if (disabledScripts && CFGetTypeID(disabledScripts) == CFArrayGetTypeID()) {
        NSArray *arr = (__bridge NSArray *)disabledScripts;
        for (id obj in arr) {
            if ([obj isKindOfClass:[NSString class]]) {
                [disabledSet addObject:[(NSString *)obj lowercaseString]];
            }
        }
    }
    if (disabledScripts) CFRelease(disabledScripts);
    cachedDisabledScripts = [disabledSet copy];
    return cachedDisabledScripts;
}

static void invalidateScriptBundleCache(void) {
    cachedDisabledScripts = nil;
    cachedCombinedStartScripts = nil;
    cachedCombinedEndScripts = nil;
}

static NSString *loadScriptsForIOSVersion(NSString *basePath, NSString *scriptsDir);

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
    NSSet *disabledSet = disabledScriptsSet();

    for (NSString *fileName in jsFiles) {
        if ([fileName isEqualToString:@"A_blacklist.js"]) continue;
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
        NSString *escapedName = jsEscapedString(fileName);
        NSString *wrapped = [NSString stringWithFormat:@"(function(n){try{if(window.__pfShouldRun && !window.__pfShouldRun(n)) return;}catch(e){}\n%@\n})(%@);\n", content, escapedName];
        [combinedScript appendString:wrapped];
    }

    return [combinedScript copy];
}

// Helper function to get base polyfills directory path
static NSString *getPolyfillsBasePath() {
    return PS_ROOT_PATH_NS(@"/Library/Application Support/Polyfills");
}

static NSString *buildBlacklistDataPrelude(void) {
    NSArray *globalBlacklist = [PolyfillsBlacklistManager mergedGlobalBlacklist];
    NSDictionary *blacklistDict = [PolyfillsBlacklistManager mergedScriptBlacklists];

    NSMutableDictionary *combinedBlacklist = [NSMutableDictionary dictionary];
    if (blacklistDict) {
        [combinedBlacklist addEntriesFromDictionary:blacklistDict];
    }
    if (globalBlacklist.count > 0) {
        combinedBlacklist[@"*"] = globalBlacklist;
    }
    if (combinedBlacklist.count == 0) {
        return nil;
    }

    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:combinedBlacklist options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (!json) json = @"{}";

    return [NSString stringWithFormat:@"window.__pfBL=%@;\n", json];
}

static NSString *loadBlacklistBootstrapScript(void) {
    NSString *path = [getPolyfillsBasePath() stringByAppendingPathComponent:@"scripts-priority/base/A_blacklist.js"];
    NSString *runner = loadJSFromFile(path);
    if (!runner.length) {
        HBLogDebug(@"Polyfills: blacklist runner not found at path: %@", path);
        return buildBlacklistDataPrelude();
    }

    NSMutableString *bootstrap = [NSMutableString string];
    NSString *dataPrelude = buildBlacklistDataPrelude();
    if (dataPrelude.length > 0) {
        [bootstrap appendString:dataPrelude];
    }
    [bootstrap appendString:runner];
    if (![bootstrap hasSuffix:@"\n"]) {
        [bootstrap appendString:@"\n"];
    }
    return [bootstrap copy];
}

static void prependBlacklistBootstrap(NSMutableString *bundle) {
    NSString *bootstrap = loadBlacklistBootstrapScript();
    if (bootstrap.length > 0) {
        [bundle insertString:bootstrap atIndex:0];
    }
}

static void buildCombinedScriptBundles(void) {
    NSString *polyfillsBasePath = getPolyfillsBasePath();
    NSMutableString *combinedStartScripts = [NSMutableString string];
    NSMutableString *combinedEndScripts = [NSMutableString string];

    NSString *priorityScripts = loadScriptsForIOSVersion(polyfillsBasePath, @"scripts-priority");
    if (priorityScripts.length > 0) {
        [combinedStartScripts appendString:priorityScripts];
        [combinedStartScripts appendString:@"\n"];
    }

    NSString *mainScripts = loadScriptsForIOSVersion(polyfillsBasePath, @"scripts");
    if (mainScripts.length > 0) {
        [combinedStartScripts appendString:mainScripts];
        [combinedStartScripts appendString:@"\n"];
    }

    NSString *postScripts = loadScriptsForIOSVersion(polyfillsBasePath, @"scripts-post");
    if (postScripts.length > 0) {
        [combinedEndScripts appendString:postScripts];
    }

    if (combinedStartScripts.length > 0) {
        prependBlacklistBootstrap(combinedStartScripts);
    } else if (combinedEndScripts.length > 0) {
        prependBlacklistBootstrap(combinedEndScripts);
    }

    cachedCombinedStartScripts = [combinedStartScripts copy];
    cachedCombinedEndScripts = [combinedEndScripts copy];
}

static void ensureScriptsLoaded(void) {
    dispatch_sync(scriptLoadingQueue, ^{
        if (!cachedCombinedStartScripts && !cachedCombinedEndScripts) {
            buildCombinedScriptBundles();
        }
    });
}

// Helper function to load scripts for a specific iOS version or older
static NSString *loadScriptsForIOSVersion(NSString *basePath, NSString *scriptsDir) {
    NSString *fullBasePath = [basePath stringByAppendingPathComponent:scriptsDir];

    NSMutableString *combinedScripts = [NSMutableString string];

    // Load base scripts (always included)
    NSString *baseScriptsPath = [fullBasePath stringByAppendingPathComponent:@"base"];
    NSString *baseScripts = loadJSFromDirectory(baseScriptsPath);
    if (baseScripts.length > 0) {
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
    if ([webView respondsToSelector:@selector(customUserAgent)]) {
        NSString *current = webView.customUserAgent;
        if (current == userAgent || [current isEqualToString:userAgent]) {
            return;
        }
    }
    if ([webView respondsToSelector:@selector(setCustomUserAgent:)])
        webView.customUserAgent = userAgent;
    else {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        if (userAgent) {
            [defaults registerDefaults:@{@"UserAgent": userAgent}];
        } else {
            [defaults removeObjectForKey:@"UserAgent"];
        }
    }
}

static void applyUserAgentOverrideForURL(WKWebView *webView, NSURL *url) {
    if (!userAgentEnabled) return;
    NSURL *resolvedURL = currentUserAgentURL(webView, url);
    HBLogDebug(@"[%p] Applying user agent override for URL: %@", webView, resolvedURL);
    if (resolvedURL == nil) {
        return;
    }
    NSString *customUA = [PolyfillsUserAgentManager customUserAgentForURL:resolvedURL];
    if (customUA != nil) {
        setUserAgent(webView, customUA);
        return;
    }
    if (isIOSVersionOrNewer(16, 3)) {
        setUserAgent(webView, nil);
        return;
    }
    if (isUserAgentBlacklistedForURL(resolvedURL)) {
        setUserAgent(webView, nil);
        return;
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    WKContentMode contentMode = WKContentModeRecommended;
    if (isIOSVersionOrNewer(13, 0))
        contentMode = webView.configuration.defaultWebpagePreferences.preferredContentMode;
    NSString *ua = IS_IPAD || contentMode == WKContentModeDesktop ? desktopUserAgent : mobileUserAgent;
#pragma clang diagnostic pop
    setUserAgent(webView, ua);
}

static void applyDefaultUserAgentOverride(WKWebView *webView) {
    if (!userAgentEnabled) return;
    NSURL *resolvedURL = currentUserAgentURL(webView, nil);
    if (resolvedURL) {
        NSString *customUA = [PolyfillsUserAgentManager customUserAgentForURL:resolvedURL];
        if (customUA != nil) {
            setUserAgent(webView, customUA);
            return;
        }
    }
    if (isIOSVersionOrNewer(16, 3)) return;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    WKContentMode contentMode = WKContentModeRecommended;
    if (isIOSVersionOrNewer(13, 0))
        contentMode = webView.configuration.defaultWebpagePreferences.preferredContentMode;
    NSString *ua = IS_IPAD || contentMode == WKContentModeDesktop ? desktopUserAgent : mobileUserAgent;
#pragma clang diagnostic pop
    HBLogDebug(@"[%p] Applying default user agent override before URL is known", webView);
    setUserAgent(webView, ua);
}

static void overrideUserAgent(WKWebView *webView) {
    NSURL *resolvedURL = currentUserAgentURL(webView, nil);
    if (resolvedURL) {
        applyUserAgentOverrideForURL(webView, resolvedURL);
        return;
    }
    applyDefaultUserAgentOverride(webView);
}

// Function to load and inject scripts synchronously from the prebuilt bundle cache
static void loadAndInjectScriptsImmediately(WKUserContentController *controller) {
    ensureScriptsLoaded();

    if (cachedCombinedStartScripts.length > 0 && controller) {
        [controller addUserScript:[[WKUserScript alloc] initWithSource:cachedCombinedStartScripts
                                                          injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                       forMainFrameOnly:NO]];
        HBLogDebug(@"Polyfills: Injected combined start scripts (%lu chars)", (unsigned long)cachedCombinedStartScripts.length);
    }
    if (cachedCombinedEndScripts.length > 0 && controller) {
        [controller addUserScript:[[WKUserScript alloc] initWithSource:cachedCombinedEndScripts
                                                          injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                                       forMainFrameOnly:NO]];
        HBLogDebug(@"Polyfills: Injected combined end scripts (%lu chars)", (unsigned long)cachedCombinedEndScripts.length);
    }
}

// Dedicated KVO observer for WKWebView URL changes.
// Using a separate object avoids conflicts with WKWebView subclass
// overrides of -observeValueForKeyPath:ofObject:change:context:.
@interface PolyfillsKVOObserver : NSObject {
    BOOL _observing;
}
- (instancetype)initWithWebView:(WKWebView *)webView;
- (void)stopObserving:(WKWebView *)webView;
@end

@implementation PolyfillsKVOObserver

- (instancetype)initWithWebView:(WKWebView *)webView {
    self = [super init];
    if (self) {
        _observing = YES;
        [webView addObserver:self forKeyPath:@"URL" options:NSKeyValueObservingOptionNew context:NULL];
    }
    return self;
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if ([keyPath isEqualToString:@"URL"]) {
        // Use the observed object directly; never hold a (weak) reference to
        // the web view, since a weak load of a deallocating object returns nil.
        WKWebView *wv = [object isKindOfClass:[WKWebView class]] ? (WKWebView *)object : nil;
        if (!wv) return;
        id newURLVal = change[NSKeyValueChangeNewKey];
        NSURL *newURL = [newURLVal isKindOfClass:[NSURL class]] ? (NSURL *)newURLVal : nil;
        HBLogDebug(@"[%p] KVO URL changed to: %@", wv, newURL);
        applyUserAgentOverrideForURL(wv, newURL);
        return;
    }
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

// Must be driven from the web view's own -dealloc (where the web view is still
// a valid object), not from this observer's -dealloc relying on a weak ref.
- (void)stopObserving:(WKWebView *)webView {
    if (_observing && webView) {
        _observing = NO;
        @try {
            [webView removeObserver:self forKeyPath:@"URL"];
        } @catch (NSException *e) {}
    }
}

@end

static const void *KVOObserverKey = &KVOObserverKey;

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
        loadAndInjectScriptsImmediately(controller);
    }
    WKWebView *webView = %orig;
    if (webView && !objc_getAssociatedObject(webView, KVOObserverKey)) {
        PolyfillsKVOObserver *observer = [[PolyfillsKVOObserver alloc] initWithWebView:webView];
        objc_setAssociatedObject(webView, KVOObserverKey, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    overrideUserAgent(webView);
    return webView;
}

- (instancetype)initWithCoder:(NSCoder *)coder {
    WKWebView *webView = %orig;
    if (webView) {
        WKUserContentController *controller = webView.configuration.userContentController;
        if (controller && !objc_getAssociatedObject(controller, InjectedKey)) {
            objc_setAssociatedObject(controller, InjectedKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            loadAndInjectScriptsImmediately(controller);
        }
        if (!objc_getAssociatedObject(webView, KVOObserverKey)) {
            PolyfillsKVOObserver *observer = [[PolyfillsKVOObserver alloc] initWithWebView:webView];
            objc_setAssociatedObject(webView, KVOObserverKey, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        overrideUserAgent(webView);
    }
    return webView;
}

- (void)dealloc {
    // Remove the KVO observer here, while `self` is still a valid web view.
    // Relying on the observer's own -dealloc fails because its weak ref to a
    // deallocating web view reads as nil, leaving the observer registered.
    PolyfillsKVOObserver *observer = objc_getAssociatedObject(self, KVOObserverKey);
    if (observer) {
        [observer stopObserving:self];
        objc_setAssociatedObject(self, KVOObserverKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    %orig;
}

- (WKNavigation *)loadRequest:(NSURLRequest *)request {
    rememberPendingUserAgentURL(self, request.URL);
    applyUserAgentOverrideForURL(self, request.URL);
    return %orig;
}

- (void)setCustomUserAgent:(NSString *)customUserAgent {
    HBLogDebug(@"[%p] Polyfills Setting custom user agent: %@", self, customUserAgent);
    NSURL *resolvedURL = currentUserAgentURL(self, nil);
    if (userAgentEnabled && resolvedURL != nil) {
        NSString *customUA = [PolyfillsUserAgentManager customUserAgentForURL:resolvedURL];
        if (customUA != nil) {
            %orig(customUA);
            return;
        }
        if (!isUserAgentBlacklistedForURL(resolvedURL) && !isIOSVersionOrNewer(16, 3)) {
            %orig(getFinalUA(customUserAgent));
            return;
        }
    }
    %orig(customUserAgent);
}

- (void)setApplicationNameForUserAgent:(NSString *)applicationNameForUserAgent {
    HBLogDebug(@"[%p] Polyfills Setting application name for user agent: %@", self, applicationNameForUserAgent);
    NSURL *resolvedURL = currentUserAgentURL(self, nil);
    if (userAgentEnabled && resolvedURL != nil) {
        NSString *customUA = [PolyfillsUserAgentManager customUserAgentForURL:resolvedURL];
        if (customUA != nil) {
            %orig(customUA);
            return;
        }
        if (!isUserAgentBlacklistedForURL(resolvedURL) && !isIOSVersionOrNewer(16, 3)) {
            %orig(getFinalUA(applicationNameForUserAgent));
            return;
        }
    }
    %orig(applicationNameForUserAgent);
}

%end

%group UserAgent

%hook NSMutableURLRequest

- (void)setValue:(NSString *)value forHTTPHeaderField:(NSString *)field {
    if ([value hasPrefix:@"Mozilla"] && [field caseInsensitiveCompare:@"User-Agent"] == NSOrderedSame) {
        NSString *customUA = [PolyfillsUserAgentManager customUserAgentForURL:self.URL];
        if (customUA != nil) {
            value = customUA;
        } else if (!isUserAgentBlacklistedForURL(self.URL) && !isIOSVersionOrNewer(16, 3)) {
            value = getFinalUA(value);
        }
    }
    %orig(value, field);
}

%end

%hook _SFReloadOptionsController

- (void)didMarkURLAsNeedingDesktopUserAgent:(id)arg1 {
    HBLogDebug(@"Polyfills didMarkURLAsNeedingDesktopUserAgent called");
    WKWebView *webView = [self valueForKey:@"_webView"];
    if (webView && !isUserAgentBlacklistedForURL(webView.URL)) setUserAgent(webView, desktopUserAgent);
    %orig;
}

- (void)didMarkURLAsNeedingStandardUserAgent:(id)arg1 {
    HBLogDebug(@"Polyfills didMarkURLAsNeedingStandardUserAgent called");
    WKWebView *webView = [self valueForKey:@"_webView"];
    if (webView) applyUserAgentOverrideForURL(webView, webView.URL);
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
    %orig;
}

%end

static void PFPrefChangedCallback(CFNotificationCenterRef center, void *observer, CFStringRef name, const void *object, CFDictionaryRef userInfo) {
    PFInvalidatePreferenceCaches();
    dispatch_sync(scriptLoadingQueue, ^{
        invalidateScriptBundleCache();
    });
}

%ctor {
    if (!isTarget(TargetTypeApps)) return;
    Boolean keyExists;
    Boolean enabled = CFPreferencesGetAppBooleanValue(key, domain, &keyExists);
    if (!(keyExists ? enabled : YES)) return;

    scriptLoadingQueue = dispatch_queue_create("com.polyfills.scriptloading", DISPATCH_QUEUE_SERIAL);

    CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(),
                                  NULL,
                                  PFPrefChangedCallback,
                                  CFSTR("com.apple.UIKit/preferences changed"),
                                  NULL,
                                  CFNotificationSuspensionBehaviorCoalesce);

    %init;

    if (CFPreferencesGetAppBooleanValue(userAgentKey, domain, NULL)) {
        userAgentEnabled = YES;
        %init(UserAgent);
    }
}
