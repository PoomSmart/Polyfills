#import "PFBridgeHandler.h"
#import <CommonCrypto/CommonDigest.h>

NSString *const PFBridgeHandlerName = @"__pfbridge";

static const NSUInteger kPFMaxBytes = 12 * 1024 * 1024;
static const int kPFCacheVer = 1;

@interface PFBridgeHandler ()
@property (nonatomic, strong) NSCache<NSString *, NSString *> *cache;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, copy) NSString *diskDir;
@end

static BOOL PFIsWebURL(NSURL *url) {
    NSString *scheme = url.scheme.lowercaseString;
    return url.host.length && ([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"]);
}

static BOOL PFLooksImmutable(NSURL *url) {
    NSString *s = [url.lastPathComponent stringByAppendingString:(url.query ?: @"")];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"[0-9a-fA-F]{8,}|[A-Za-z0-9_-]{20,}" options:0 error:nil];
    return [re numberOfMatchesInString:s options:0 range:NSMakeRange(0, s.length)] > 0;
}

@implementation PFBridgeHandler

+ (instancetype)shared {
    static PFBridgeHandler *handler;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        handler = [PFBridgeHandler new];
    });
    return handler;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _cache = [NSCache new];
        _cache.totalCostLimit = 48 * 1024 * 1024;
        NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        cfg.HTTPShouldSetCookies = NO;
        cfg.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
        cfg.timeoutIntervalForRequest = 25;
        cfg.HTTPMaximumConnectionsPerHost = 8;
        cfg.URLCache = [[NSURLCache alloc] initWithMemoryCapacity:16 * 1024 * 1024 diskCapacity:0 diskPath:nil];
        _session = [NSURLSession sessionWithConfiguration:cfg];
        NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
        if (caches) {
            NSFileManager *fm = [NSFileManager defaultManager];
            for (int v = 1; v < kPFCacheVer; v++) {
                [fm removeItemAtPath:[caches stringByAppendingPathComponent:[NSString stringWithFormat:@"Polyfills-v%d", v]] error:nil];
            }
            _diskDir = [caches stringByAppendingPathComponent:[NSString stringWithFormat:@"Polyfills-v%d", kPFCacheVer]];
            [fm createDirectoryAtPath:_diskDir withIntermediateDirectories:YES attributes:nil error:nil];
        }
    }
    return self;
}

- (NSString *)diskPathForKey:(NSString *)cacheKey {
    if (!self.diskDir) return nil;
    NSData *d = [cacheKey dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char md[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(d.bytes, (CC_LONG)d.length, md);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA1_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", md[i]];
    return [self.diskDir stringByAppendingPathComponent:hex];
}

- (NSString *)cachedForKey:(NSString *)cacheKey url:(NSURL *)url {
    NSString *v = [self.cache objectForKey:cacheKey];
    if (v) return v;
    if (!PFLooksImmutable(url)) return nil;
    NSString *path = [self diskPathForKey:cacheKey];
    v = path ? [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] : nil;
    if (v) [self.cache setObject:v forKey:cacheKey cost:v.length + 1];
    return v;
}

- (void)store:(NSString *)value cacheKey:(NSString *)cacheKey url:(NSURL *)url {
    if (!value) return;
    [self.cache setObject:value forKey:cacheKey cost:value.length + 1];
    if (!PFLooksImmutable(url)) return;
    NSString *path = [self diskPathForKey:cacheKey];
    if (!path) return;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [value writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    });
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id reply, NSString *errorMessage))replyHandler {
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
    NSString *op = [body[@"op"] isKindOfClass:[NSString class]] ? body[@"op"] : nil;

    if ([op isEqualToString:@"eval"]) {
        NSString *code = [body[@"code"] isKindOfClass:[NSString class]] ? body[@"code"] : nil;
        WKWebView *webView = message.webView;
        if (!code || !webView) {
            replyHandler(nil, @"bad eval");
            return;
        }
        void (^reply)(id, NSString *) = [replyHandler copy];
        if (@available(iOS 14.0, *)) {
            [webView evaluateJavaScript:code
                                 inFrame:message.frameInfo
                          inContentWorld:WKContentWorld.pageWorld
                       completionHandler:^(id result, NSError *error) {
                if (error) reply(nil, error.localizedDescription ?: @"eval failed");
                else reply(@YES, nil);
            }];
        } else {
            reply(nil, @"unavailable");
        }
        return;
    }

    NSString *kind = [body[@"kind"] isKindOfClass:[NSString class]] ? body[@"kind"] : @"css";
    NSString *urlString = [body[@"url"] isKindOfClass:[NSString class]] ? body[@"url"] : nil;
    NSURL *url = urlString.length ? [NSURL URLWithString:urlString] : nil;
    if (!op || !url || !PFIsWebURL(url)) {
        replyHandler(nil, @"bad request");
        return;
    }
    NSString *cacheKey = [kind stringByAppendingFormat:@":%@", urlString];

    if ([op isEqualToString:@"put"]) {
        NSString *data = [body[@"data"] isKindOfClass:[NSString class]] ? body[@"data"] : nil;
        if (data && data.length < kPFMaxBytes * 2) [self store:data cacheKey:cacheKey url:url];
        replyHandler(@YES, nil);
        return;
    }

    if (![op isEqualToString:@"get"]) {
        replyHandler(nil, @"bad op");
        return;
    }

    NSString *cached = [self cachedForKey:cacheKey url:url];
    if (cached) {
        replyHandler(@{ @"data": cached }, nil);
        return;
    }

    BOOL wantJS = [kind isEqualToString:@"js"] || [kind isEqualToString:@"jsraw"] || [kind isEqualToString:@"cjs"];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    [req setValue:(wantJS ? @"*/*" : @"text/css,*/*;q=0.1") forHTTPHeaderField:@"Accept"];
    WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
    if (origin.host.length) {
        NSString *originString = [NSString stringWithFormat:@"%@://%@", origin.protocol ?: @"https", origin.host];
        if (origin.port) originString = [originString stringByAppendingFormat:@":%ld", (long)origin.port];
        [req setValue:[originString stringByAppendingString:@"/"] forHTTPHeaderField:@"Referer"];
        [req setValue:originString forHTTPHeaderField:@"Origin"];
    }

    void (^reply)(id, NSString *) = [replyHandler copy];
    [[self.session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
        NSString *text = nil;
        NSHTTPURLResponse *http = [resp isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)resp : nil;
        NSString *mime = resp.MIMEType.lowercaseString ?: @"";
        NSString *path = url.path.lowercaseString;
        BOOL typeOK = wantJS
            ? ([mime containsString:@"javascript"] || [mime containsString:@"ecmascript"] || [path hasSuffix:@".js"] || [path hasSuffix:@".mjs"])
            : ([mime containsString:@"css"] || [path hasSuffix:@".css"] || [mime containsString:@"text/"] || mime.length == 0);
        BOOL ok = !err && data && data.length < kPFMaxBytes &&
                  (!http || (http.statusCode >= 200 && http.statusCode < 300)) && typeOK;
        if (ok) {
            text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            if (!text) text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (text) {
                [self store:text cacheKey:cacheKey url:url];
                reply(@{ @"raw": text }, nil);
            } else {
                reply(nil, @"fetch failed");
            }
        });
    }] resume];
}

@end
