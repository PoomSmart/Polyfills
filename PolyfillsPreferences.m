// For LLM: Ignore header import issues

#import <PSHeader/Misc.h>
#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import "Header.h"
#import <Preferences/PSListController.h>
#import <Preferences/PSSpecifier.h>
#import <UIKit/UIKit.h>
#import <HBLog.h>

// Simple logging helper
#define PFPrefsLog(fmt, ...) HBLogDebug(@"[PolyfillsPrefs] " fmt, ##__VA_ARGS__)

static NSString *PFBasePath(void) {
    return PS_ROOT_PATH_NS(@"/Library/Application Support/Polyfills");
}

static NSArray *PFScriptDirs(void) {
    return @[ @"scripts-priority", @"scripts", @"scripts-post" ];
}

@interface PolyfillsRootListController : PSListController
@end

@interface PolyfillsScriptBlacklistController : PSListController <UITextFieldDelegate>
@property(nonatomic, strong) NSString *scriptName;               // lowercase
@property(nonatomic, strong) NSMutableArray *domains;            // mutable list of lowercase domains
@property(nonatomic, strong) NSMutableDictionary *allBlacklists; // script -> domains array
@end

@implementation PolyfillsRootListController {
    NSMutableSet *_disabledScripts;   // lowercase
    NSMutableDictionary *_blacklists; // script -> domains
}

- (void)loadPrefs {
    CFArrayRef dis = (CFArrayRef)CFPreferencesCopyAppValue(disabledScriptsKey, domain);
    _disabledScripts = [NSMutableSet set];
    if (dis && CFGetTypeID(dis) == CFArrayGetTypeID())
        for (NSString *s in (__bridge NSArray *)dis)
            [_disabledScripts addObject:s.lowercaseString];
    if (dis)
        CFRelease(dis);
    CFDictionaryRef bl = (CFDictionaryRef)CFPreferencesCopyAppValue(scriptBlacklistKey, domain);
    _blacklists = [NSMutableDictionary dictionary];
    if (bl && CFGetTypeID(bl) == CFDictionaryGetTypeID())
        [_blacklists addEntriesFromDictionary:(__bridge NSDictionary *)bl];
    if (bl)
        CFRelease(bl);
    PFPrefsLog(@"Root loadPrefs: disabled=%lu, blacklistKeys=%@", (unsigned long)_disabledScripts.count,
               _blacklists.allKeys);
}

- (NSArray *)specifiers {
    if (!_specifiers) {
        [self loadPrefs];
        NSMutableArray *specs = [NSMutableArray array];
        PSSpecifier *grp = [PSSpecifier preferenceSpecifierNamed:@"Polyfills"
                                                          target:self
                                                             set:NULL
                                                             get:NULL
                                                          detail:Nil
                                                            cell:PSGroupCell
                                                            edit:Nil];
        [specs addObject:grp];

        PSSpecifier *en = [PSSpecifier preferenceSpecifierNamed:@"Enabled"
                                                         target:self
                                                            set:@selector(setPreferenceValue:specifier:)
                                                            get:@selector(readPreferenceValue:)
                                                         detail:Nil
                                                           cell:PSSwitchCell
                                                           edit:Nil];
        [en setProperty:(__bridge NSString *)domain forKey:@"defaults"];
        [en setProperty:(__bridge NSString *)key forKey:@"key"];
        [en setProperty:@YES forKey:@"default"];
        [specs addObject:en];

        // Group for Spoof User Agent toggle
        PSSpecifier *uaGrp = [PSSpecifier preferenceSpecifierNamed:@"Spoof User Agent"
                                                            target:self
                                                               set:NULL
                                                               get:NULL
                                                            detail:Nil
                                                              cell:PSGroupCell
                                                              edit:Nil];
        [uaGrp setProperty:@"Spoof User Agent to iOS 16.3. May improve compatibility on some websites. May also break "
                           @"some other websites."
                    forKey:@"footerText"];
        [specs addObject:uaGrp];
        PSSpecifier *ua = [PSSpecifier preferenceSpecifierNamed:@"Enabled"
                                                         target:self
                                                            set:@selector(setPreferenceValue:specifier:)
                                                            get:@selector(readPreferenceValue:)
                                                         detail:Nil
                                                           cell:PSSwitchCell
                                                           edit:Nil];
        [ua setProperty:(__bridge NSString *)domain forKey:@"defaults"];
        [ua setProperty:(__bridge NSString *)userAgentKey forKey:@"key"];
        [ua setProperty:@NO forKey:@"default"];
        [specs addObject:ua];
        NSOperatingSystemVersion osv = [[NSProcessInfo processInfo] operatingSystemVersion];
        // iOS version gate: show only on iOS 11.0 - 16.3 inclusive
        BOOL showHeaderToggle = (osv.majorVersion == 11 || osv.majorVersion > 11) && // >=11
                                ((osv.majorVersion < 16) || (osv.majorVersion == 16 && osv.minorVersion <= 3));
        if (showHeaderToggle) {
            // Group for Header Injection toggle with explanatory footer
            PSSpecifier *hiGrp = [PSSpecifier preferenceSpecifierNamed:@"Header Injection"
                                                                target:self
                                                                   set:NULL
                                                                   get:NULL
                                                                detail:Nil
                                                                  cell:PSGroupCell
                                                                  edit:Nil];
            [hiGrp setProperty:@"Inject Sec-Fetch-* headers for certain requests (iOS < 16.4). Can improve site "
                               @"compatibility; disable if pages misbehave."
                        forKey:@"footerText"];
            [specs addObject:hiGrp];
            PSSpecifier *hi = [PSSpecifier preferenceSpecifierNamed:@"Enabled"
                                                             target:self
                                                                set:@selector(setPreferenceValue:specifier:)
                                                                get:@selector(readPreferenceValue:)
                                                             detail:Nil
                                                               cell:PSSwitchCell
                                                               edit:Nil];
            [hi setProperty:(__bridge NSString *)domain forKey:@"defaults"];
            [hi setProperty:(__bridge NSString *)headerInjectionKey forKey:@"key"];
            [hi setProperty:@NO forKey:@"default"];
            [specs addObject:hi];
        }

        PSSpecifier *scriptsGrp = [PSSpecifier preferenceSpecifierNamed:@"Scripts"
                                                                 target:self
                                                                    set:NULL
                                                                    get:NULL
                                                                 detail:Nil
                                                                   cell:PSGroupCell
                                                                   edit:Nil];
        [scriptsGrp setProperty:@"Toggle individual scripts and edit blacklists." forKey:@"footerText"];
        [specs addObject:scriptsGrp];

        // Collect script metadata first so we can sort by version threshold.
        NSMutableArray *entries = [NSMutableArray array];
        NSFileManager *fm = [NSFileManager defaultManager];
        NSRegularExpression *verRegex = [NSRegularExpression regularExpressionWithPattern:@"^\\d+\\.\\d+$"
                                                                                  options:0
                                                                                    error:nil];
        NSMutableSet *seen = [NSMutableSet set];
        for (NSString *top in PFScriptDirs()) {
            NSString *topPath = [[PFBasePath() stringByAppendingPathComponent:top] stringByStandardizingPath];
            // Base scripts (always applicable) use synthetic version 0.0 so they sort first.
            NSString *baseDir = [topPath stringByAppendingPathComponent:@"base"];
            for (NSString *f in [fm contentsOfDirectoryAtPath:baseDir error:nil])
                if ([f hasSuffix:@".js"]) {
                    NSString *lower = f.lowercaseString;
                    if ([seen containsObject:lower])
                        continue; // first one wins
                    [seen addObject:lower];
                    NSUInteger blCount = [[_blacklists objectForKey:lower] count];
                    [entries addObject:@{
                        @"label" : f,
                        @"script" : lower,
                        @"blCount" : @(blCount),
                        @"major" : @0,
                        @"minor" : @0,
                        @"isBase" : @YES
                    }];
                }
            // Version directories (only those whose threshold is greater than current OS -> still active)
            NSArray *topItems = [fm contentsOfDirectoryAtPath:topPath error:nil];
            for (NSString *sub in topItems) {
                if ([sub isEqualToString:@"base"])
                    continue;
                if ([verRegex numberOfMatchesInString:sub options:0 range:NSMakeRange(0, sub.length)] == 0)
                    continue;
                NSArray *comps = [sub componentsSeparatedByString:@"."];
                NSInteger vMajor = comps.count > 0 ? [comps[0] integerValue] : 0;
                NSInteger vMinor = comps.count > 1 ? [comps[1] integerValue] : 0;
                BOOL currentIsOlder =
                    (osv.majorVersion < vMajor) || (osv.majorVersion == vMajor && osv.minorVersion < vMinor);
                if (!currentIsOlder)
                    continue; // skip inactive dirs
                NSString *verDir = [topPath stringByAppendingPathComponent:sub];
                for (NSString *f in [fm contentsOfDirectoryAtPath:verDir error:nil])
                    if ([f hasSuffix:@".js"]) {
                        NSString *lower = f.lowercaseString;
                        if ([seen containsObject:lower])
                            continue;
                        [seen addObject:lower];
                        NSUInteger blCount = [[_blacklists objectForKey:lower] count];
                        NSString *label = [NSString stringWithFormat:@"%@@%@", f, sub];
                        [entries addObject:@{
                            @"label" : label,
                            @"script" : lower,
                            @"blCount" : @(blCount),
                            @"major" : @(vMajor),
                            @"minor" : @(vMinor),
                            @"isBase" : @NO
                        }];
                    }
            }
        }
        // Sort: base first, then ascending version (major, minor), then label.
        [entries sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
          BOOL aBase = [a[@"isBase"] boolValue];
          BOOL bBase = [b[@"isBase"] boolValue];
          if (aBase != bBase)
              return aBase ? NSOrderedAscending : NSOrderedDescending;
          NSInteger aMaj = [a[@"major"] integerValue];
          NSInteger bMaj = [b[@"major"] integerValue];
          if (aMaj != bMaj)
              return aMaj < bMaj ? NSOrderedAscending : NSOrderedDescending;
          NSInteger aMin = [a[@"minor"] integerValue];
          NSInteger bMin = [b[@"minor"] integerValue];
          if (aMin != bMin)
              return aMin < bMin ? NSOrderedAscending : NSOrderedDescending;
          return [a[@"label"] caseInsensitiveCompare:b[@"label"]];
        }];
        // Build specifiers in sorted order, each script in its own group.
        for (NSDictionary *entry in entries) {
            NSString *label = entry[@"label"]; // May include version suffix
            NSString *script = entry[@"script"];
            NSUInteger blCount = [entry[@"blCount"] unsignedIntegerValue];
            // Group header for this script
            PSSpecifier *scriptGroup = [PSSpecifier preferenceSpecifierNamed:label
                                                                      target:self
                                                                         set:NULL
                                                                         get:NULL
                                                                      detail:Nil
                                                                        cell:PSGroupCell
                                                                        edit:Nil];
            [specs addObject:scriptGroup];
            // Toggle
            PSSpecifier *tog = [PSSpecifier preferenceSpecifierNamed:@"Enabled"
                                                              target:self
                                                                 set:@selector(setScriptEnabled:specifier:)
                                                                 get:@selector(isScriptEnabled:)
                                                              detail:Nil
                                                                cell:PSSwitchCell
                                                                edit:Nil];
            [tog setProperty:script forKey:@"scriptName"];
            [specs addObject:tog];
            // Blacklist link
            NSString *blLabel = [NSString stringWithFormat:@"Blacklist (%lu)", (unsigned long)blCount];
            PSSpecifier *edit = [PSSpecifier preferenceSpecifierNamed:blLabel
                                                               target:self
                                                                  set:NULL
                                                                  get:NULL
                                                               detail:[PolyfillsScriptBlacklistController class]
                                                                 cell:PSLinkCell
                                                                 edit:Nil];
            [edit setProperty:script forKey:@"scriptName"];
            [edit setProperty:@YES forKey:@"enabled"];
            [edit setProperty:@YES forKey:@"isController"];
            [specs addObject:edit];
        }

        PSSpecifier *footer = [PSSpecifier preferenceSpecifierNamed:@"About"
                                                             target:self
                                                                set:NULL
                                                                get:NULL
                                                             detail:Nil
                                                               cell:PSGroupCell
                                                               edit:Nil];
        [footer setProperty:@"© 2025 PoomSmart" forKey:@"footerText"];
        [specs addObject:footer];
        _specifiers = specs;
    }
    return _specifiers;
}

- (id)isScriptEnabled:(PSSpecifier *)spec {
    return @(![_disabledScripts containsObject:[spec propertyForKey:@"scriptName"]]);
}

- (void)setScriptEnabled:(id)val specifier:(PSSpecifier *)spec {
    NSString *n = [spec propertyForKey:@"scriptName"];
    if ([val boolValue])
        [_disabledScripts removeObject:n];
    else
        [_disabledScripts addObject:n];
    [self saveDisabled];
}

- (void)saveDisabled {
    CFPreferencesSetAppValue(disabledScriptsKey, (__bridge CFArrayRef)_disabledScripts.allObjects, domain);
    CFPreferencesAppSynchronize(domain);
    PFPrefsLog(@"Saved disabled scripts (%lu)", (unsigned long)_disabledScripts.count);
}

@end

@implementation PolyfillsScriptBlacklistController

- (void)viewDidLoad {
    [super viewDidLoad];
    self.navigationItem.rightBarButtonItem =
        [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemSave
                                                      target:self
                                                      action:@selector(saveAndClose)];
}

- (UIView *)_findFirstResponder:(UIView *)v {
    if (v.isFirstResponder)
        return v;
    for (UIView *sub in v.subviews) {
        UIView *r = [self _findFirstResponder:sub];
        if (r)
            return r;
    }
    return nil;
}

- (UITableView *)_tableView {
    // Try common patterns, fallback to scanning subviews.
    if ([self respondsToSelector:@selector(table)]) {
        UITableView *t = [self performSelector:@selector(table)];
        if ([t isKindOfClass:[UITableView class]])
            return t;
    }
    if ([self.view isKindOfClass:[UITableView class]])
        return (UITableView *)self.view;
    for (UIView *sub in self.view.subviews)
        if ([sub isKindOfClass:[UITableView class]])
            return (UITableView *)sub;
    return nil;
}

// Recursively locate first UITextField in a view hierarchy
static UITextField *PFLocateTextField(UIView *root) {
    if ([root isKindOfClass:[UITextField class]])
        return (UITextField *)root;
    for (UIView *sub in root.subviews) {
        UITextField *f = PFLocateTextField(sub);
        if (f)
            return f;
    }
    return nil;
}

- (void)_commitCell:(UITableViewCell *)cell {
    if (!cell)
        return;
    PSSpecifier *spec =
        [cell respondsToSelector:@selector(specifier)] ? [cell performSelector:@selector(specifier)] : nil;
    UITextField *tf = PFLocateTextField(cell.contentView ?: cell);
    if (!spec && !tf)
        return; // nothing to commit
    if (!spec) {
        PFPrefsLog(@"_commitCell: no specifier for cell class=%@", NSStringFromClass(cell.class));
        return;
    }
    NSString *text = tf ? (tf.text ?: @"") : @"";
    PFPrefsLog(@"_commitCell specName=%@ cellClass=%@ text='%@'", [spec name], NSStringFromClass(cell.class), text);
    if ([[spec name] isEqualToString:@"Add"]) {
        NSString *vLower = text.lowercaseString;
        if (vLower.length && ![self.domains containsObject:vLower]) {
            PFPrefsLog(@"Adding domain from Add Domain cell (full reload path): %@", vLower);
            [self.domains addObject:vLower];
            if (tf)
                tf.text = @"";
            [spec setProperty:@"" forKey:@"value"]; // reset Add Domain field
            // Persist BEFORE rebuilding so specifiers() picks up new domains.
            [self persist];
            _specifiers = nil; // Force full rebuild to avoid row mismatch
            [self reloadSpecifiers];
        }
    } else {
        NSString *old = [spec propertyForKey:@"value"] ?: @"";
        if (![old isEqualToString:text]) {
            PFPrefsLog(@"Updating existing domain old=%@ new=%@", old, text);
            [self setDomain:text specifier:spec];
        }
    }
}

- (void)_commitAllEdits {
    UITableView *tv = [self _tableView];
    if (!tv)
        return;
    PFPrefsLog(@"_commitAllEdits visibleCount=%lu", (unsigned long)tv.visibleCells.count);
    for (UITableViewCell *cell in tv.visibleCells) {
        [self _commitCell:cell];
    }
    // Offscreen: attempt to load and commit every specifier that might have a text field (link cells excluded)
    for (PSSpecifier *spec in _specifiers) {
        if ([spec cellType] == PSEditTextCell) {
            UITableViewCell *cell = [self cachedCellForSpecifier:spec];
            if (cell)
                [self _commitCell:cell];
        }
    }
}

- (void)saveAndClose {
    // Commit all edits (visible + offscreen) then persist.
    PFPrefsLog(@"saveAndClose initial domains=%@", self.domains);
    [self.view endEditing:YES];
    [self _commitAllEdits];
    PFPrefsLog(@"saveAndClose after commit domains=%@", self.domains);
    [self persist];
}

- (NSArray *)specifiers {
    if (!_specifiers) {
        self.scriptName = [[self.specifier propertyForKey:@"scriptName"] lowercaseString];
        // load master dictionary
        CFPreferencesAppSynchronize(domain); // ensure latest values from other processes
        CFDictionaryRef bl = (CFDictionaryRef)CFPreferencesCopyAppValue(scriptBlacklistKey, domain);
        self.allBlacklists = [NSMutableDictionary dictionary];
        if (bl && CFGetTypeID(bl) == CFDictionaryGetTypeID())
            [self.allBlacklists addEntriesFromDictionary:(__bridge NSDictionary *)bl];
        if (bl)
            CFRelease(bl);
        self.domains = [self.allBlacklists[self.scriptName] ?: @[] mutableCopy];
        PFPrefsLog(@"Blacklist specifiers init for script=%@ loadedKeys=%@ currentDomains=%@", self.scriptName,
                   self.allBlacklists.allKeys, self.domains);
        NSMutableArray *specs = [NSMutableArray array];
        PSSpecifier *grp = [PSSpecifier preferenceSpecifierNamed:self.scriptName
                                                          target:self
                                                             set:NULL
                                                             get:NULL
                                                          detail:Nil
                                                            cell:PSGroupCell
                                                            edit:Nil];
        [grp setProperty:@"Domains or host/path (example.com, example.com/blog). Subdomains match automatically. To "
                         @"delete an entry, clear its text and tap Save."
                  forKey:@"footerText"];
        [specs addObject:grp];
        for (NSString *d in self.domains) {
            // Use a short bullet label; the text field already displays the domain value.
            PSSpecifier *t = [PSSpecifier preferenceSpecifierNamed:@"•"
                                                            target:self
                                                               set:@selector(setDomain:specifier:)
                                                               get:@selector(getDomain:)
                                                            detail:Nil
                                                              cell:PSEditTextCell
                                                              edit:Nil];
            [t setProperty:d forKey:@"value"];
            [specs addObject:t];
        }
        PSSpecifier *add = [PSSpecifier preferenceSpecifierNamed:@"Add"
                                                          target:self
                                                             set:@selector(addDomain:specifier:)
                                                             get:NULL
                                                          detail:Nil
                                                            cell:PSEditTextCell
                                                            edit:Nil];
        [add setProperty:@"" forKey:@"value"];
        [specs addObject:add];
        _specifiers = specs;
    }
    return _specifiers;
}

- (id)getDomain:(PSSpecifier *)spec {
    return [spec propertyForKey:@"value"];
}

- (void)setDomain:(id)val specifier:(PSSpecifier *)spec {
    NSString *old = [spec propertyForKey:@"value"];
    NSString *v = [[val description] lowercaseString];
    PFPrefsLog(@"setDomain old=%@ new=%@ script=%@", old, v, self.scriptName);
    if (v.length == 0) {
        [self.domains removeObject:old];
        [self removeSpecifier:spec animated:YES];
    } else {
        NSUInteger idx = [self.domains indexOfObject:old];
        if (idx != NSNotFound)
            self.domains[idx] = v;
        else if (![self.domains containsObject:v])
            [self.domains addObject:v];
        [spec setProperty:v forKey:@"value"]; // Keep bullet label constant
    }
    [self persist];
}

- (void)addDomain:(id)val specifier:(PSSpecifier *)spec {
    NSString *vLower = [[val description] lowercaseString];
    PFPrefsLog(@"addDomain candidate=%@ script=%@ existing=%@", vLower, self.scriptName, self.domains);
    if (vLower.length && ![self.domains containsObject:vLower]) {
        [self.domains addObject:vLower];
        NSInteger insertIndex = _specifiers.count - 1; // before Add Domain row
        // Bullet label to avoid duplicate domain text
        PSSpecifier *t = [PSSpecifier preferenceSpecifierNamed:@"•"
                                                        target:self
                                                           set:@selector(setDomain:specifier:)
                                                           get:@selector(getDomain:)
                                                        detail:Nil
                                                          cell:PSEditTextCell
                                                          edit:Nil];
        [t setProperty:vLower forKey:@"value"];
        [_specifiers insertObject:t atIndex:insertIndex];
        [self insertSpecifier:t atIndex:insertIndex animated:YES];
        // Reset the Add Domain row's value so user can add another without manual clearing.
        [spec setProperty:@"" forKey:@"value"];
        [self persist];
    }
}

- (void)persist {
    if (self.domains.count)
        self.allBlacklists[self.scriptName] = self.domains;
    else
        [self.allBlacklists removeObjectForKey:self.scriptName];
    NSDictionary *snapshot = [self.allBlacklists copy];
    CFPreferencesSetAppValue(scriptBlacklistKey, (__bridge CFDictionaryRef)snapshot, domain);
    CFPreferencesAppSynchronize(domain);
    PFPrefsLog(@"persist script=%@ domains=%@ allKeys=%@", self.scriptName, self.domains, self.allBlacklists.allKeys);
}

- (void)viewWillAppear:(BOOL)animated {
    [super viewWillAppear:animated];
    // Reload in case another process or earlier controller instance updated preferences.
    CFPreferencesAppSynchronize(domain);
    CFDictionaryRef bl = (CFDictionaryRef)CFPreferencesCopyAppValue(scriptBlacklistKey, domain);
    NSMutableDictionary *latest = [NSMutableDictionary dictionary];
    if (bl && CFGetTypeID(bl) == CFDictionaryGetTypeID())
        [latest addEntriesFromDictionary:(__bridge NSDictionary *)bl];
    if (bl)
        CFRelease(bl);
    NSArray *updated = [latest[self.scriptName] ?: @[] copy];
    PFPrefsLog(@"viewWillAppear script=%@ latestKeys=%@ updatedDomains=%@ currentDomains=%@", self.scriptName,
               latest.allKeys, updated, self.domains);
    if (![updated isEqualToArray:self.domains]) {
        self.allBlacklists = latest;
        self.domains = [updated mutableCopy];
        // Rebuild specifiers list only if counts differ
        _specifiers = nil;
        [self reloadSpecifiers];
        PFPrefsLog(@"Rebuilt specifiers for script=%@ newDomains=%@", self.scriptName, self.domains);
    }
}

@end
