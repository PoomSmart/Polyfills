/*
 * Injection order:
 *   Document start (critical): unwrapped blacklist + A_globals + iOS < 9 Symbol
 *   Document start (rest):     scripts-priority + scripts (wrapped)
 *   Document end:              scripts-post (wrapped)
 * Critical is a separate WKUserScript so a SyntaxError in the huge rest bundle
 * cannot skip identifier bindings (iOS 8 does not bind window.X as a global name).
 */

#define CHECK_TARGET
#import <HBLog.h>
#import <PSHeader/PS.h>
#import <WebKit/WebKit.h>
#import <theos/IOSMacros.h>
#import <version.h>
#import "Header.h"
#import "PFBridgeHandler.h"

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
    NSArray<NSString *> *blacklist = [PFBlacklistManager mergedUserAgentBlacklist];
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

static dispatch_queue_t scriptLoadingQueue;
static NSString *cachedCriticalStartScripts = nil;
static NSString *cachedCombinedStartScripts = nil;
static NSString *cachedCombinedEndScripts = nil;

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
    cachedCriticalStartScripts = nil;
    cachedCombinedStartScripts = nil;
    cachedCombinedEndScripts = nil;
}

static NSString *loadScriptsForIOSVersion(NSString *basePath, NSString *scriptsDir);

// Unwrapped into the critical start script. major 0 = all iOS versions.
// Filenames are skipped by loadJSFromDirectory so they are not duplicated.
typedef struct {
    __unsafe_unretained NSString *path;
    NSInteger major;
    NSInteger minor;
} PFUnwrappedStartScript;

static const PFUnwrappedStartScript kUnwrappedStartScripts[] = {
    { @"scripts-priority/base/A_globals.js", 0, 0 },
    { @"scripts/9.0/Object.getOwnPropertySymbols.js", 9, 0 },
};

static NSSet *unwrappedStartFileNames(void) {
    static NSSet *names;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSMutableSet *set = [NSMutableSet setWithObject:@"A_blacklist.js"];
        for (size_t i = 0; i < sizeof(kUnwrappedStartScripts) / sizeof(kUnwrappedStartScripts[0]); i++) {
            [set addObject:kUnwrappedStartScripts[i].path.lastPathComponent];
        }
        names = [set copy];
    });
    return names;
}

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

    NSArray *jsFiles = [[files filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"pathExtension == 'js'"]]
                       sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)];

    NSMutableString *combinedScript = [NSMutableString string];
    NSSet *disabledSet = disabledScriptsSet();

    for (NSString *fileName in jsFiles) {
        if ([unwrappedStartFileNames() containsObject:fileName]) continue;
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
        NSString *escapedName = jsEscapedString(fileName);
        NSString *wrapped = [NSString stringWithFormat:@"(function(n){if(typeof window.__pfShouldRun==\"function\"&&!window.__pfShouldRun(n))return;\n%@\n})(%@);\n", content, escapedName];
        [combinedScript appendString:wrapped];
    }

    return [combinedScript copy];
}

static NSString *getPolyfillsBasePath() {
    return PS_ROOT_PATH_NS(@"/Library/Application Support/Polyfills");
}

static NSString *buildBlacklistDataPrelude(void) {
    NSArray *globalBlacklist = [PFBlacklistManager mergedGlobalBlacklist];
    NSDictionary *blacklistDict = [PFBlacklistManager mergedScriptBlacklists];

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

static NSString *loadUnwrappedScript(NSString *relativePath) {
    NSString *path = [getPolyfillsBasePath() stringByAppendingPathComponent:relativePath];
    NSString *content = loadJSFromFile(path);
    return content.length ? content : @"";
}

static void appendUnwrappedScript(NSMutableString *bundle, NSString *relativePath) {
    NSString *fileName = relativePath.lastPathComponent;
    NSSet *disabledSet = disabledScriptsSet();
    if (disabledSet && [disabledSet containsObject:fileName.lowercaseString]) return;
    NSString *content = loadUnwrappedScript(relativePath);
    if (!content.length) return;
    [bundle appendString:content];
    if (![bundle hasSuffix:@"\n"]) {
        [bundle appendString:@"\n"];
    }
}

static void appendUnwrappedStartScripts(NSMutableString *bundle) {
    for (size_t i = 0; i < sizeof(kUnwrappedStartScripts) / sizeof(kUnwrappedStartScripts[0]); i++) {
        PFUnwrappedStartScript spec = kUnwrappedStartScripts[i];
        if (spec.major > 0 && isIOSVersionOrNewer(spec.major, spec.minor)) continue;
        appendUnwrappedScript(bundle, spec.path);
    }
}

static void buildCombinedScriptBundles(void) {
    NSString *polyfillsBasePath = getPolyfillsBasePath();
    NSMutableString *criticalStartScripts = [NSMutableString string];
    NSMutableString *combinedStartScripts = [NSMutableString string];
    NSMutableString *combinedEndScripts = [NSMutableString string];

    NSString *bootstrap = loadBlacklistBootstrapScript();
    if (bootstrap.length > 0) {
        [criticalStartScripts appendString:bootstrap];
        if (![criticalStartScripts hasSuffix:@"\n"]) {
            [criticalStartScripts appendString:@"\n"];
        }
    }
    appendUnwrappedStartScripts(criticalStartScripts);

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

    cachedCriticalStartScripts = [criticalStartScripts copy];
    cachedCombinedStartScripts = [combinedStartScripts copy];
    cachedCombinedEndScripts = [combinedEndScripts copy];
}

static void ensureScriptsLoaded(void) {
    dispatch_sync(scriptLoadingQueue, ^{
        if (!cachedCriticalStartScripts && !cachedCombinedStartScripts && !cachedCombinedEndScripts) {
            buildCombinedScriptBundles();
        }
    });
}

static NSString *loadScriptsForIOSVersion(NSString *basePath, NSString *scriptsDir) {
    NSString *fullBasePath = [basePath stringByAppendingPathComponent:scriptsDir];

    NSMutableString *combinedScripts = [NSMutableString string];

    NSString *baseScriptsPath = [fullBasePath stringByAppendingPathComponent:@"base"];
    NSString *baseScripts = loadJSFromDirectory(baseScriptsPath);
    if (baseScripts.length > 0) {
        [combinedScripts appendString:baseScripts];
        [combinedScripts appendString:@"\n"];
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSError *error;
    NSArray *allItems = [fileManager contentsOfDirectoryAtPath:fullBasePath error:&error];
    if (error) {
        HBLogDebug(@"Polyfills: Error reading scripts directory %@: %@", fullBasePath, error.localizedDescription);
        return [combinedScripts copy];
    }

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

    for (NSString *versionStr in versionDirs) {
        NSArray *components = [versionStr componentsSeparatedByString:@"."];
        NSInteger vMajor = [components[0] integerValue];
        NSInteger vMinor = components.count > 1 ? [components[1] integerValue] : 0;

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
    NSString *customUA = [PFUserAgentManager customUserAgentForURL:resolvedURL];
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
        NSString *customUA = [PFUserAgentManager customUserAgentForURL:resolvedURL];
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

static const void *InjectedKey = &InjectedKey;

static void PFInstallBridge(WKUserContentController *controller) {
    if (!controller || !isIOSVersionOrNewer(14, 0)) return;
    if (@available(iOS 14.0, *)) {
        @try {
            [controller addScriptMessageHandlerWithReply:[PFBridgeHandler shared]
                                            contentWorld:WKContentWorld.pageWorld
                                                    name:PFBridgeHandlerName];
        } @catch (NSException *e) {
        }
    }
}

static void loadAndInjectScriptsImmediately(WKUserContentController *controller) {
    ensureScriptsLoaded();

    if (cachedCriticalStartScripts.length > 0 && controller) {
        [controller addUserScript:[[WKUserScript alloc] initWithSource:cachedCriticalStartScripts
                                                          injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                       forMainFrameOnly:NO]];
        HBLogDebug(@"Polyfills: Injected critical start scripts (%lu chars)", (unsigned long)cachedCriticalStartScripts.length);
    }
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

static void installPolyfillsOnController(WKUserContentController *controller) {
    if (!controller || objc_getAssociatedObject(controller, InjectedKey)) return;
    objc_setAssociatedObject(controller, InjectedKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    loadAndInjectScriptsImmediately(controller);
    PFInstallBridge(controller);
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

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    WKUserContentController *controller = configuration.userContentController;
    if (!controller) {
        controller = [[WKUserContentController alloc] init];
        configuration.userContentController = controller;
    }
    installPolyfillsOnController(controller);
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
        installPolyfillsOnController(webView.configuration.userContentController);
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
        NSString *customUA = [PFUserAgentManager customUserAgentForURL:resolvedURL];
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
        NSString *customUA = [PFUserAgentManager customUserAgentForURL:resolvedURL];
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
        NSString *customUA = [PFUserAgentManager customUserAgentForURL:self.URL];
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

%hook WKUserContentController

- (void)removeAllUserScripts {
    %orig;
    if (objc_getAssociatedObject(self, InjectedKey)) {
        loadAndInjectScriptsImmediately(self);
    }
}

- (void)removeAllScriptMessageHandlers {
    %orig;
    if (objc_getAssociatedObject(self, InjectedKey)) {
        PFInstallBridge(self);
    }
}

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
