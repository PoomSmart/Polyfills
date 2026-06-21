#import <Foundation/Foundation.h>
#import <theos/IOSMacros.h>
#import "Header.h"

static NSMutableDictionary<NSString *, NSString *> *defaultCustomUserAgents = nil;
static NSMutableDictionary<NSString *, NSString *> *runtimeCustomUserAgents = nil;

@implementation PolyfillsUserAgentManager

+ (void)initialize {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      defaultCustomUserAgents = [NSMutableDictionary dictionary];
      runtimeCustomUserAgents = [NSMutableDictionary dictionary];

      // Sensible default hardcoded custom user agents for specific websites
      //   defaultCustomUserAgents[@"website.com"] = @"";
    });
}

+ (void)registerDefaultCustomUserAgent:(NSString *)userAgent forWebsites:(NSArray<NSString *> *)websites {
    [self initialize];
    if (userAgent.length == 0 || websites.count == 0)
        return;
    @synchronized(defaultCustomUserAgents) {
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                defaultCustomUserAgents[site.lowercaseString] = userAgent;
            }
        }
    }
}

+ (void)addCustomUserAgent:(NSString *)userAgent forWebsites:(NSArray<NSString *> *)websites {
    [self initialize];
    if (userAgent.length == 0 || websites.count == 0)
        return;
    @synchronized(runtimeCustomUserAgents) {
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                runtimeCustomUserAgents[site.lowercaseString] = userAgent;
            }
        }
    }
}

+ (NSString *)customUserAgentForURL:(NSURL *)url {
    [self initialize];
    if (url == nil)
        return nil;

    NSMutableDictionary *combined = [NSMutableDictionary dictionary];

    // 1. Gather defaults
    @synchronized(defaultCustomUserAgents) {
        [combined addEntriesFromDictionary:defaultCustomUserAgents];
    }

    // 2. Gather runtime programmatic overrides
    @synchronized(runtimeCustomUserAgents) {
        [combined addEntriesFromDictionary:runtimeCustomUserAgents];
    }

    // 3. Gather user preferences
    CFDictionaryRef userPref = (CFDictionaryRef)CFPreferencesCopyAppValue(customUserAgentsKey, domain);
    if (userPref && CFGetTypeID(userPref) == CFDictionaryGetTypeID()) {
        NSDictionary *userPrefDict = (__bridge NSDictionary *)userPref;
        for (NSString *aKey in userPrefDict) {
            id val = userPrefDict[aKey];
            if ([aKey isKindOfClass:[NSString class]] && [val isKindOfClass:[NSString class]]) {
                combined[aKey.lowercaseString] = val;
            }
        }
    }
    if (userPref)
        CFRelease(userPref);

    if (combined.count == 0)
        return nil;

    // Sort rules by length descending so that more specific rules (e.g. paths) are checked first
    NSArray *sortedRules =
        [combined.allKeys sortedArrayUsingComparator:^NSComparisonResult(NSString *rule1, NSString *rule2) {
          if (rule1.length > rule2.length)
              return NSOrderedAscending;
          if (rule1.length < rule2.length)
              return NSOrderedDescending;
          return NSOrderedSame;
        }];

    for (NSString *rule in sortedRules) {
        if (PFDomainPathMatchesURL(rule, url)) {
            return combined[rule];
        }
    }

    return nil;
}

@end
