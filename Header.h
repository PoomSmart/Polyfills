#define domain CFSTR("com.apple.UIKit")
#define key CFSTR("PolyfillsEnabled")
#define userAgentKey CFSTR("PolyfillsUserAgentEnabled")
#define userAgentBlacklistKey CFSTR("PolyfillsUserAgentBlacklist")
#define headerInjectionKey CFSTR("PolyfillsHeaderInjectionEnabled")
#define disabledScriptsKey CFSTR("PolyfillsDisabledScripts")
#define scriptBlacklistKey CFSTR("PolyfillsScriptBlacklist")
#define globalBlacklistKey CFSTR("PolyfillsGlobalBlacklist")

@interface PolyfillsBlacklistManager : NSObject

// Programmatic Registration of Defaults
+ (void)registerDefaultUserAgentBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)registerDefaultGlobalBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)registerDefaultBlacklistedWebsites:(NSArray<NSString *> *)websites forScript:(NSString *)scriptName;

// Programmatic Additions at Runtime
+ (void)addUserAgentBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)addGlobalBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)addBlacklistedWebsites:(NSArray<NSString *> *)websites forScript:(NSString *)scriptName;

// Retrieving Merged Blacklists
+ (NSArray<NSString *> *)mergedUserAgentBlacklist;
+ (NSArray<NSString *> *)mergedGlobalBlacklist;
+ (NSDictionary<NSString *, NSArray<NSString *> *> *)mergedScriptBlacklists;

@end

