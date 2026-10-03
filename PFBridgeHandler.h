#import <WebKit/WebKit.h>

FOUNDATION_EXPORT NSString *const PFBridgeHandlerName;

@interface PFBridgeHandler : NSObject <WKScriptMessageHandlerWithReply>
+ (instancetype)shared;
@end
