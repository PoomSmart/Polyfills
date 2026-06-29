#import <Foundation/Foundation.h>
#import "Header.h"

static NSMutableSet<NSString *> *defaultUABlacklist = nil;
static NSMutableSet<NSString *> *defaultGlobalBlacklist = nil;
static NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *defaultScriptBlacklists = nil;

static NSMutableSet<NSString *> *runtimeUABlacklist = nil;
static NSMutableSet<NSString *> *runtimeGlobalBlacklist = nil;
static NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *runtimeScriptBlacklists = nil;

static NSArray<NSString *> *cachedUABlacklist = nil;
static NSArray<NSString *> *cachedGlobalBlacklist = nil;
static NSDictionary<NSString *, NSArray<NSString *> *> *cachedScriptBlacklists = nil;
static dispatch_queue_t blacklistCacheQueue;

@implementation PolyfillsBlacklistManager

+ (void)initialize {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        defaultUABlacklist = [NSMutableSet setWithArray:@[
            @"gemini.google.com",
            @"youtube.com/tv",
        ]];
        
        defaultGlobalBlacklist = [NSMutableSet setWithArray:@[
            // Add things
        ]];
        
        defaultScriptBlacklists = [NSMutableDictionary dictionary];
        defaultScriptBlacklists[@"regexp.min.js"] = [NSMutableSet setWithArray:@[
            @"americanexpress.com",
            @"amtrak.com",
            @"duck.ai",
        ]];
        
        runtimeUABlacklist = [NSMutableSet set];
        runtimeGlobalBlacklist = [NSMutableSet set];
        runtimeScriptBlacklists = [NSMutableDictionary dictionary];
        blacklistCacheQueue = dispatch_queue_create("com.polyfills.blacklistcache", DISPATCH_QUEUE_SERIAL);
    });
}

+ (void)registerDefaultUserAgentBlacklistedWebsites:(NSArray<NSString *> *)websites {
    [self initialize];
    @synchronized (defaultUABlacklist) {
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                [defaultUABlacklist addObject:site.lowercaseString];
            }
        }
    }
    [self invalidateCaches];
}

+ (void)registerDefaultGlobalBlacklistedWebsites:(NSArray<NSString *> *)websites {
    [self initialize];
    @synchronized (defaultGlobalBlacklist) {
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                [defaultGlobalBlacklist addObject:site.lowercaseString];
            }
        }
    }
    [self invalidateCaches];
}

+ (void)registerDefaultBlacklistedWebsites:(NSArray<NSString *> *)websites forScript:(NSString *)scriptName {
    [self initialize];
    if (scriptName.length == 0) return;
    NSString *lowerScriptName = scriptName.lowercaseString;
    @synchronized (defaultScriptBlacklists) {
        NSMutableSet *set = defaultScriptBlacklists[lowerScriptName];
        if (!set) {
            set = [NSMutableSet set];
            defaultScriptBlacklists[lowerScriptName] = set;
        }
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                [set addObject:site.lowercaseString];
            }
        }
    }
    [self invalidateCaches];
}

+ (void)addUserAgentBlacklistedWebsites:(NSArray<NSString *> *)websites {
    [self initialize];
    @synchronized (runtimeUABlacklist) {
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                [runtimeUABlacklist addObject:site.lowercaseString];
            }
        }
    }
    [self invalidateCaches];
}

+ (void)addGlobalBlacklistedWebsites:(NSArray<NSString *> *)websites {
    [self initialize];
    @synchronized (runtimeGlobalBlacklist) {
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                [runtimeGlobalBlacklist addObject:site.lowercaseString];
            }
        }
    }
    [self invalidateCaches];
}

+ (void)addBlacklistedWebsites:(NSArray<NSString *> *)websites forScript:(NSString *)scriptName {
    [self initialize];
    if (scriptName.length == 0) return;
    NSString *lowerScriptName = scriptName.lowercaseString;
    @synchronized (runtimeScriptBlacklists) {
        NSMutableSet *set = runtimeScriptBlacklists[lowerScriptName];
        if (!set) {
            set = [NSMutableSet set];
            runtimeScriptBlacklists[lowerScriptName] = set;
        }
        for (NSString *site in websites) {
            if ([site isKindOfClass:[NSString class]] && site.length > 0) {
                [set addObject:site.lowercaseString];
            }
        }
    }
    [self invalidateCaches];
}

+ (void)invalidateCaches {
    [self initialize];
    dispatch_sync(blacklistCacheQueue, ^{
        cachedUABlacklist = nil;
        cachedGlobalBlacklist = nil;
        cachedScriptBlacklists = nil;
    });
}

+ (NSArray<NSString *> *)mergedUserAgentBlacklist {
    [self initialize];
    __block NSArray<NSString *> *merged = nil;
    dispatch_sync(blacklistCacheQueue, ^{
        if (cachedUABlacklist) {
            merged = cachedUABlacklist;
            return;
        }

        NSMutableSet *set = [NSMutableSet set];
        CFArrayRef userPref = (CFArrayRef)CFPreferencesCopyAppValue(userAgentBlacklistKey, domain);
        if (userPref && CFGetTypeID(userPref) == CFArrayGetTypeID()) {
            for (id obj in (__bridge NSArray *)userPref) {
                if ([obj isKindOfClass:[NSString class]]) {
                    [set addObject:[(NSString *)obj lowercaseString]];
                }
            }
        }
        if (userPref) CFRelease(userPref);

        @synchronized (defaultUABlacklist) {
            [set unionSet:defaultUABlacklist];
        }
        @synchronized (runtimeUABlacklist) {
            [set unionSet:runtimeUABlacklist];
        }
        cachedUABlacklist = [set allObjects];
        merged = cachedUABlacklist;
    });
    return merged;
}

+ (NSArray<NSString *> *)mergedGlobalBlacklist {
    [self initialize];
    __block NSArray<NSString *> *merged = nil;
    dispatch_sync(blacklistCacheQueue, ^{
        if (cachedGlobalBlacklist) {
            merged = cachedGlobalBlacklist;
            return;
        }

        NSMutableSet *set = [NSMutableSet set];
        CFArrayRef userPref = (CFArrayRef)CFPreferencesCopyAppValue(globalBlacklistKey, domain);
        if (userPref && CFGetTypeID(userPref) == CFArrayGetTypeID()) {
            for (id obj in (__bridge NSArray *)userPref) {
                if ([obj isKindOfClass:[NSString class]]) {
                    [set addObject:[(NSString *)obj lowercaseString]];
                }
            }
        }
        if (userPref) CFRelease(userPref);

        @synchronized (defaultGlobalBlacklist) {
            [set unionSet:defaultGlobalBlacklist];
        }
        @synchronized (runtimeGlobalBlacklist) {
            [set unionSet:runtimeGlobalBlacklist];
        }
        cachedGlobalBlacklist = [set allObjects];
        merged = cachedGlobalBlacklist;
    });
    return merged;
}

+ (NSDictionary<NSString *, NSArray<NSString *> *> *)mergedScriptBlacklists {
    [self initialize];
    __block NSDictionary<NSString *, NSArray<NSString *> *> *merged = nil;
    dispatch_sync(blacklistCacheQueue, ^{
        if (cachedScriptBlacklists) {
            merged = cachedScriptBlacklists;
            return;
        }

        NSMutableDictionary<NSString *, NSMutableSet *> *dict = [NSMutableDictionary dictionary];
        
        CFDictionaryRef userPref = (CFDictionaryRef)CFPreferencesCopyAppValue(scriptBlacklistKey, domain);
        if (userPref && CFGetTypeID(userPref) == CFDictionaryGetTypeID()) {
            NSDictionary *userPrefDict = (__bridge NSDictionary *)userPref;
            for (NSString *aKey in userPrefDict) {
                id val = userPrefDict[aKey];
                if ([val isKindOfClass:[NSArray class]]) {
                    NSMutableSet *set = [NSMutableSet set];
                    for (id obj in val) {
                        if ([obj isKindOfClass:[NSString class]]) {
                            [set addObject:[(NSString *)obj lowercaseString]];
                        }
                    }
                    dict[aKey.lowercaseString] = set;
                }
            }
        }
        if (userPref) CFRelease(userPref);

        @synchronized (defaultScriptBlacklists) {
            for (NSString *aKey in defaultScriptBlacklists) {
                NSMutableSet *set = dict[aKey];
                if (!set) {
                    set = [NSMutableSet set];
                    dict[aKey] = set;
                }
                [set unionSet:defaultScriptBlacklists[aKey]];
            }
        }

        @synchronized (runtimeScriptBlacklists) {
            for (NSString *aKey in runtimeScriptBlacklists) {
                NSMutableSet *set = dict[aKey];
                if (!set) {
                    set = [NSMutableSet set];
                    dict[aKey] = set;
                }
                [set unionSet:runtimeScriptBlacklists[aKey]];
            }
        }

        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        for (NSString *aKey in dict) {
            result[aKey] = [dict[aKey] allObjects];
        }
        cachedScriptBlacklists = [result copy];
        merged = cachedScriptBlacklists;
    });
    return merged;
}

@end
