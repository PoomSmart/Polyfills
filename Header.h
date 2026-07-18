#import <Foundation/Foundation.h>

#define domain CFSTR("com.apple.UIKit")
#define key CFSTR("PolyfillsEnabled")
#define userAgentKey CFSTR("PolyfillsUserAgentEnabled")
#define userAgentBlacklistKey CFSTR("PolyfillsUserAgentBlacklist")
#define customUserAgentsKey CFSTR("PolyfillsCustomUserAgents")
#define headerInjectionKey CFSTR("PolyfillsHeaderInjectionEnabled")
#define disabledScriptsKey CFSTR("PolyfillsDisabledScripts")
#define scriptBlacklistKey CFSTR("PolyfillsScriptBlacklist")
#define globalBlacklistKey CFSTR("PolyfillsGlobalBlacklist")

static inline BOOL PFDomainPathMatchesURL(NSString *entry, NSURL *url) {
    if (entry.length == 0 || url == nil) return NO;
    NSString *host = url.host.lowercaseString ?: @"";
    NSString *path = url.path ?: @"/";
    NSString *rule = entry.lowercaseString;
    NSRange slash = [rule rangeOfString:@"/"];
    if (slash.location == NSNotFound) {
        return [host isEqualToString:rule] || [host hasSuffix:[@"." stringByAppendingString:rule]];
    }

    NSString *ruleHost = [rule substringToIndex:slash.location];
    NSString *rulePath = [rule substringFromIndex:slash.location];
    if (!([host isEqualToString:ruleHost] || [host hasSuffix:[@"." stringByAppendingString:ruleHost]])) {
        return NO;
    }
    return [path isEqualToString:rulePath] || [path hasPrefix:[rulePath hasSuffix:@"/"] ? rulePath : [rulePath stringByAppendingString:@"/"]];
}

@interface PolyfillsBlacklistManager : NSObject

+ (void)registerDefaultUserAgentBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)registerDefaultGlobalBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)registerDefaultBlacklistedWebsites:(NSArray<NSString *> *)websites forScript:(NSString *)scriptName;

+ (void)addUserAgentBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)addGlobalBlacklistedWebsites:(NSArray<NSString *> *)websites;
+ (void)addBlacklistedWebsites:(NSArray<NSString *> *)websites forScript:(NSString *)scriptName;

+ (NSArray<NSString *> *)mergedUserAgentBlacklist;
+ (NSArray<NSString *> *)mergedGlobalBlacklist;
+ (NSDictionary<NSString *, NSArray<NSString *> *> *)mergedScriptBlacklists;

+ (void)invalidateCaches;

@end

void PFInvalidatePreferenceCaches(void);

@interface PolyfillsUserAgentManager : NSObject

+ (void)registerDefaultCustomUserAgent:(NSString *)userAgent forWebsites:(NSArray<NSString *> *)websites;

+ (void)addCustomUserAgent:(NSString *)userAgent forWebsites:(NSArray<NSString *> *)websites;

+ (NSString *)customUserAgentForURL:(NSURL *)url;

+ (void)invalidateCaches;

@end

