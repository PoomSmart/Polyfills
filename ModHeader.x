#import <WebKit/WebKit.h>
#import <Foundation/Foundation.h>
#import <version.h>
#import <PSHeader/Misc.h>
#import "Header.h"

static inline NSString *PFSecRulesDir(void) {
    return [PS_ROOT_PATH_NS(@"/Library/Application Support/Polyfills") stringByAppendingPathComponent:@"sec-rules"];
}

// Rules index loaded from all files: exact host -> rule dict, suffix (no leading dot) -> rule dict
static NSDictionary<NSString *, NSDictionary *> *s_rulesExact;
static NSDictionary<NSString *, NSDictionary *> *s_rulesSuffix;
static void _PFEnsureRulesLoaded(void) {
    static BOOL s_loaded = NO;
    if (s_loaded) return;

    NSMutableDictionary *exact = [NSMutableDictionary dictionary];
    NSMutableDictionary *suffix = [NSMutableDictionary dictionary];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *rulesDir = PFSecRulesDir();
    NSArray<NSString *> *files = [fm contentsOfDirectoryAtPath:rulesDir error:nil];
    NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];

    for (NSString *file in files) {
        if (![[file pathExtension].lowercaseString isEqualToString:@"txt"]) continue;
        NSString *base = [[file lastPathComponent] stringByDeletingPathExtension];
        NSString *path = [rulesDir stringByAppendingPathComponent:file];
        NSError *err = nil;
        NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&err];
        if (!content) continue;

        __block NSString *currentPattern = base; // default to file name
        __block NSMutableDictionary *current = [NSMutableDictionary dictionaryWithCapacity:3];

        void (^flush)(void) = ^{
            if (currentPattern.length && current.count) {
                if ([currentPattern hasPrefix:@"."]) {
                    suffix[[currentPattern substringFromIndex:1].lowercaseString] = [current copy];
                } else {
                    exact[currentPattern.lowercaseString] = [current copy];
                }
            }
            current = [NSMutableDictionary dictionaryWithCapacity:3];
        };

        [content enumerateLinesUsingBlock:^(NSString *line, BOOL *stop) {
            NSString *trim = [line stringByTrimmingCharactersInSet:ws];
            if (trim.length == 0) return;
            if ([trim hasPrefix:@"#"] || [trim hasPrefix:@"//"]) return;
            if ([trim hasPrefix:@"["] && [trim hasSuffix:@"]"]) {
                flush();
                NSString *inside = [trim substringWithRange:NSMakeRange(1, trim.length - 2)];
                currentPattern = [inside stringByTrimmingCharactersInSet:ws];
                return;
            }
            NSRange sep = [trim rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@":="]];
            if (sep.location == NSNotFound) return;
            NSString *aKey = [[trim substringToIndex:sep.location] stringByTrimmingCharactersInSet:ws].lowercaseString;
            NSString *val = [[trim substringFromIndex:(sep.location + 1)] stringByTrimmingCharactersInSet:ws];
            if (val.length == 0) return;
            if ([aKey isEqualToString:@"host"] || [aKey isEqualToString:@"url"]) {
                flush();
                currentPattern = val;
                return;
            }
            if ([aKey isEqualToString:@"dest"] || [aKey isEqualToString:@"mode"] || [aKey isEqualToString:@"site"]) {
                current[aKey] = val;
            }
        }];
        flush();
    }
    s_rulesExact = [exact copy];
    s_rulesSuffix = [suffix copy];
    s_loaded = YES;
}

// Lookup: exact, then parent domains, then longest-matching suffix (subdomains only)
static NSDictionary *_PFHeaderRuleForHost(NSString *host) {
    if (host.length == 0) return nil;
    _PFEnsureRulesLoaded();

    NSString *h = host.lowercaseString;
    NSDictionary *rule = s_rulesExact[h];
    if (rule) return rule;
    while (true) {
        NSRange dot = [h rangeOfString:@"."];
        if (dot.location == NSNotFound) break;
        h = [h substringFromIndex:(dot.location + 1)];
        if (h.length == 0) break;
        rule = s_rulesExact[h];
        if (rule) return rule;
    }
    // suffix rules: subdomain-only, choose the longest matching suffix
    NSString *bestKey = nil;
    for (NSString *aKey in s_rulesSuffix) {
        NSString *needle = [@"." stringByAppendingString:aKey];
        if ([host hasSuffix:needle]) {
            if (!bestKey || aKey.length > bestKey.length) bestKey = aKey;
        }
    }
    return bestKey ? s_rulesSuffix[bestKey] : nil;
}

static inline NSDictionary *_PFHeaderRuleForURL(NSURL *url) {
    return _PFHeaderRuleForHost(url.host ?: @"");
}

static inline BOOL _PFHeaderInjectionEnabled(void) {
    Boolean exists = false;
    Boolean value = CFPreferencesGetAppBooleanValue(headerInjectionKey, domain, &exists);
    return exists && value;
}

NS_AVAILABLE_IOS(11.0)
@interface SchemeHandler : NSObject <WKURLSchemeHandler>
@end

@implementation SchemeHandler
{
    NSMapTable<id<WKURLSchemeTask>, NSURLSessionDataTask *> *_taskMap; // weak keys -> strong values
    dispatch_queue_t _taskQueue; // serialize access to map
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _taskQueue = dispatch_queue_create("com.ps.polyfills.schemehandler", DISPATCH_QUEUE_SERIAL);
        _taskMap = [[NSMapTable alloc] initWithKeyOptions:(NSPointerFunctionsWeakMemory | NSPointerFunctionsObjectPointerPersonality)
                                            valueOptions:NSPointerFunctionsStrongMemory
                                                capacity:0];
    }
    return self;
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    NSURLRequest *origReq = urlSchemeTask.request;
    NSURL *url = origReq.URL;
    if (!url) {
        NSError *err = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil];
        [urlSchemeTask didFailWithError:err];
        return;
    }

    NSURLRequest *forwardReq = origReq;
    NSDictionary *rule = _PFHeaderRuleForURL(url);
    if (rule.count > 0) {
        NSMutableURLRequest *req = [origReq mutableCopy];
        NSString *dest = rule[@"dest"];
        NSString *mode = rule[@"mode"];
        NSString *site = rule[@"site"];
        if (dest.length) [req setValue:dest forHTTPHeaderField:@"Sec-Fetch-Dest"];
        if (mode.length) [req setValue:mode forHTTPHeaderField:@"Sec-Fetch-Mode"];
        if (site.length) [req setValue:site forHTTPHeaderField:@"Sec-Fetch-Site"];
        forwardReq = req;
    }

    NSURLSessionDataTask *dataTask = [[NSURLSession sharedSession] dataTaskWithRequest:forwardReq
                                                                     completionHandler:^(NSData * _Nullable data, NSURLResponse * _Nullable response, NSError * _Nullable error) {
        __block BOOL stillActive = NO;
        dispatch_sync(self->_taskQueue, ^{
            stillActive = ([self->_taskMap objectForKey:urlSchemeTask] != nil);
            [self->_taskMap removeObjectForKey:urlSchemeTask];
        });

        if (!stillActive) {
            return; // Task was cancelled
        }

        if (error) {
            if (error.code != NSURLErrorCancelled) {
                [urlSchemeTask didFailWithError:error];
            }
        } else {
            if (response) [urlSchemeTask didReceiveResponse:response];
            if (data) [urlSchemeTask didReceiveData:data];
            [urlSchemeTask didFinish];
        }
    }];

    dispatch_async(_taskQueue, ^{
        [self->_taskMap setObject:dataTask forKey:urlSchemeTask];
    });
    [dataTask resume];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)urlSchemeTask {
    dispatch_async(_taskQueue, ^{
        NSURLSessionDataTask *t = [self->_taskMap objectForKey:urlSchemeTask];
        if (t) {
            [t cancel];
            [self->_taskMap removeObjectForKey:urlSchemeTask];
        }
    });
}

@end

%hook WKWebView

+ (BOOL)handlesURLScheme:(NSString *)urlScheme {
    if ([urlScheme isEqualToString:@"https"] || [urlScheme isEqualToString:@"http"]) {
        return NO;
    }
    return %orig;
}

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    static SchemeHandler *handler;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        handler = [SchemeHandler new];
    });
    if (@available(iOS 11.0, *)) {
        [configuration setURLSchemeHandler:handler forURLScheme:@"http"];
        [configuration setURLSchemeHandler:handler forURLScheme:@"https"];
    }
    return %orig;
}

%end

%hook WKWebViewConfiguration

- (void)setURLSchemeHandler:(id <WKURLSchemeHandler>)urlSchemeHandler forURLScheme:(NSString *)urlScheme {
    @try {
        %orig;
    } @catch (id ex) {}
}

%end

%ctor {
    // Activate only on iOS 11.0 through 16.3 and when the preference is enabled
    if (!IS_IOS_OR_NEWER(iOS_11_0) || IS_IOS_OR_NEWER(iOS_16_4)) return;
    if (!_PFHeaderInjectionEnabled()) return;
    %init;
}