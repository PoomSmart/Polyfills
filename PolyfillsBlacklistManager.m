#import <Foundation/Foundation.h>
#import "Header.h"

static NSMutableSet<NSString *> *defaultUABlacklist = nil;
static NSMutableSet<NSString *> *defaultGlobalBlacklist = nil;
static NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *defaultScriptBlacklists = nil;

static NSMutableSet<NSString *> *runtimeUABlacklist = nil;
static NSMutableSet<NSString *> *runtimeGlobalBlacklist = nil;
static NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *runtimeScriptBlacklists = nil;

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
        // Example of a script-specific hardcoded default blacklist
        defaultScriptBlacklists[@"regexp.min.js"] = [NSMutableSet setWithArray:@[
            @"duck.ai",
        ]];
        
        runtimeUABlacklist = [NSMutableSet set];
        runtimeGlobalBlacklist = [NSMutableSet set];
        runtimeScriptBlacklists = [NSMutableDictionary dictionary];
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
}

+ (NSArray<NSString *> *)mergedUserAgentBlacklist {
    [self initialize];
    NSMutableSet *merged = [NSMutableSet set];
    CFArrayRef userPref = (CFArrayRef)CFPreferencesCopyAppValue(userAgentBlacklistKey, domain);
    if (userPref && CFGetTypeID(userPref) == CFArrayGetTypeID()) {
        for (id obj in (__bridge NSArray *)userPref) {
            if ([obj isKindOfClass:[NSString class]]) {
                [merged addObject:[(NSString *)obj lowercaseString]];
            }
        }
    }
    if (userPref) CFRelease(userPref);

    @synchronized (defaultUABlacklist) {
        [merged unionSet:defaultUABlacklist];
    }
    @synchronized (runtimeUABlacklist) {
        [merged unionSet:runtimeUABlacklist];
    }
    return [merged allObjects];
}

+ (NSArray<NSString *> *)mergedGlobalBlacklist {
    [self initialize];
    NSMutableSet *merged = [NSMutableSet set];
    CFArrayRef userPref = (CFArrayRef)CFPreferencesCopyAppValue(globalBlacklistKey, domain);
    if (userPref && CFGetTypeID(userPref) == CFArrayGetTypeID()) {
        for (id obj in (__bridge NSArray *)userPref) {
            if ([obj isKindOfClass:[NSString class]]) {
                [merged addObject:[(NSString *)obj lowercaseString]];
            }
        }
    }
    if (userPref) CFRelease(userPref);

    @synchronized (defaultGlobalBlacklist) {
        [merged unionSet:defaultGlobalBlacklist];
    }
    @synchronized (runtimeGlobalBlacklist) {
        [merged unionSet:runtimeGlobalBlacklist];
    }
    return [merged allObjects];
}

+ (NSDictionary<NSString *, NSArray<NSString *> *> *)mergedScriptBlacklists {
    [self initialize];
    NSMutableDictionary<NSString *, NSMutableSet *> *merged = [NSMutableDictionary dictionary];
    
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
                merged[aKey.lowercaseString] = set;
            }
        }
    }
    if (userPref) CFRelease(userPref);

    @synchronized (defaultScriptBlacklists) {
        for (NSString *aKey in defaultScriptBlacklists) {
            NSMutableSet *set = merged[aKey];
            if (!set) {
                set = [NSMutableSet set];
                merged[aKey] = set;
            }
            [set unionSet:defaultScriptBlacklists[aKey]];
        }
    }

    @synchronized (runtimeScriptBlacklists) {
        for (NSString *aKey in runtimeScriptBlacklists) {
            NSMutableSet *set = merged[aKey];
            if (!set) {
                set = [NSMutableSet set];
                merged[aKey] = set;
            }
            [set unionSet:runtimeScriptBlacklists[aKey]];
        }
    }

    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    for (NSString *aKey in merged) {
        result[aKey] = [merged[aKey] allObjects];
    }
    return [result copy];
}

@end
