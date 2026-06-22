#import <Foundation/Foundation.h>
#import <theos/IOSMacros.h>
#import "Header.h"

static NSMutableDictionary<NSString *, NSString *> *defaultCustomUserAgents = nil;
static NSMutableDictionary<NSString *, NSString *> *runtimeCustomUserAgents = nil;

static NSDictionary<NSString *, NSString *> *cachedMergedUserAgents = nil;
static dispatch_queue_t uaCacheQueue;

@implementation PolyfillsUserAgentManager

+ (void)initialize {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      defaultCustomUserAgents = [NSMutableDictionary dictionary];
      runtimeCustomUserAgents = [NSMutableDictionary dictionary];
      uaCacheQueue = dispatch_queue_create("com.polyfills.uacache", DISPATCH_QUEUE_SERIAL);
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
    [self invalidateCaches];
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
    [self invalidateCaches];
}

+ (NSDictionary<NSString *, NSString *> *)mergedCustomUserAgents {
    [self initialize];
    __block NSDictionary<NSString *, NSString *> *merged = nil;
    dispatch_sync(uaCacheQueue, ^{
        if (cachedMergedUserAgents) {
            merged = cachedMergedUserAgents;
            return;
        }

        NSMutableDictionary *combined = [NSMutableDictionary dictionary];
        @synchronized(defaultCustomUserAgents) {
            [combined addEntriesFromDictionary:defaultCustomUserAgents];
        }
        @synchronized(runtimeCustomUserAgents) {
            [combined addEntriesFromDictionary:runtimeCustomUserAgents];
        }

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

        cachedMergedUserAgents = [combined copy];
        merged = cachedMergedUserAgents;
    });
    return merged;
}

+ (void)invalidateCaches {
    [self initialize];
    dispatch_sync(uaCacheQueue, ^{
        cachedMergedUserAgents = nil;
    });
}

+ (NSString *)customUserAgentForURL:(NSURL *)url {
    [self initialize];
    if (url == nil)
        return nil;

    NSDictionary *combined = [self mergedCustomUserAgents];
    if (combined.count == 0)
        return nil;

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

void PFInvalidatePreferenceCaches(void) {
    [PolyfillsUserAgentManager invalidateCaches];
    [PolyfillsBlacklistManager invalidateCaches];
}
