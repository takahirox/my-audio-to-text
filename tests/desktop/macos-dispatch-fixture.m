#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <assert.h>

// Exercise the production helper with a real, private pasteboard and AppKit
// editor. Substitute focus, event posting and time to avoid OS permissions,
// real clipboard changes or timing dependencies in delayed consumption.
static NSPasteboard *clipboard;
static NSTextView *editors[3];
static id fields[3], systemElement;
static NSUInteger focused, keyDowns, keyUps;
static pid_t frontPid = 100;
static pid_t systemFieldPID;
static BOOL trusted = YES, canPost = YES;
static BOOL secureInput, protectedField, disabledField, readOnly, notEditable;
static BOOL modifiers, noField, systemField, noRole, menu;
static BOOL failSnapshot, failStage, failRestore, copyAfterStage, pauseAfterStage;
static BOOL switchDuringProtection, switchLayoutAfterStage;
static pid_t switchAppAfterStage;
static BOOL currentHostOnly;
static CGKeyCode layoutPasteKey = kVK_ANSI_Period;
static dispatch_semaphore_t resumeFocus;
static int64_t focusStallMs;
static NSString *quitReport;
static dispatch_block_t consumePaste, settlePaste;
static uint64_t timeMs, consumeAt, settleAt;
static const uint64_t targetReadDelayMs = 150;
static NSMutableArray<NSString *> *reads;
static NSMutableArray<NSNumber *> *keyCodes;
static void emitMessage(NSDictionary *message);

@interface FixtureWorkspace : NSObject
@property (readonly) NSRunningApplication *frontmostApplication;
@property (readonly) pid_t processIdentifier;
+ (instancetype)sharedWorkspace;
@end

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSRunningApplication *)frontmostApplication { return (NSRunningApplication *)self; }
- (pid_t)processIdentifier { return frontPid; }
@end

static void copyText(NSString *text) {
    currentHostOnly = NO;
    [clipboard clearContents];
    assert([clipboard setString:text forType:NSPasteboardTypeString]);
}

@interface FixturePasteboard : NSObject
@property (class, readonly) FixturePasteboard *generalPasteboard;
@property (readonly) NSInteger changeCount;
@property (readonly) NSArray<NSPasteboardItem *> *pasteboardItems;
- (NSInteger)clearContents;
- (NSInteger)prepareForNewContentsWithOptions:(NSPasteboardContentsOptions)options;
- (BOOL)writeObjects:(NSArray<id<NSPasteboardWriting>> *)objects;
@end

@implementation FixturePasteboard
+ (instancetype)generalPasteboard { return [self new]; }
- (NSInteger)changeCount { return clipboard.changeCount; }
- (NSArray<NSPasteboardItem *> *)pasteboardItems { return failSnapshot ? nil : clipboard.pasteboardItems; }
- (NSInteger)clearContents {
    currentHostOnly = NO;
    return [clipboard clearContents];
}
- (NSInteger)prepareForNewContentsWithOptions:(NSPasteboardContentsOptions)options {
    currentHostOnly = (options & NSPasteboardContentsCurrentHostOnly) != 0;
    return [clipboard prepareForNewContentsWithOptions:options];
}
- (BOOL)writeObjects:(NSArray<id<NSPasteboardWriting>> *)objects {
    BOOL staging = [[(NSPasteboardItem *)objects.firstObject types] containsObject:@"org.nspasteboard.TransientType"];
    if (staging ? failStage : failRestore) return NO;
    BOOL wrote = [clipboard writeObjects:objects];
    if (staging && switchAppAfterStage) {
        focused = 2;
        frontPid = switchAppAfterStage;
    }
    if (staging && switchLayoutAfterStage) layoutPasteKey = kVK_ANSI_V;
    if (staging && copyAfterStage) copyText(@"copied before dispatch");
    return wrote;
}
@end

static AXError copyAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    NSString *key = (__bridge NSString *)attribute;
    id object = (__bridge id)element;
    id result = nil;
    if ([key isEqual:@"AXFocusedUIElement"]) {
        if (object == systemElement ? systemField : !noField) result = fields[focused];
    } else if ([key isEqual:@"AXRole"] && !noRole) result = menu ? @"AXMenuItem" : @"AXTextArea";
    else if ([key isEqual:@"AXSubrole"]) {
        // Move focus after the post-staging identity and AXFocused reads.
        if (switchDuringProtection && object == fields[0] &&
            [clipboard availableTypeFromArray:@[@"org.nspasteboard.TransientType"]]) {
            switchDuringProtection = NO;
            focused = 1;
        }
        if (protectedField) result = @"AXSecureTextField";
    } else if ([key isEqual:@"AXEnabled"]) result = @(!disabledField);
    else if ([key isEqual:@"AXFocused"]) result = @(object == fields[focused]);
    else if ([key isEqual:@"AXReadOnly"] && readOnly) result = @YES;
    else if ([key isEqual:@"AXEditable"] && notEditable) result = @NO;
    *value = CFBridgingRetain(result);
    if ([key isEqual:@"AXFocusedUIElement"] && pauseAfterStage && [clipboard availableTypeFromArray:@[@"org.nspasteboard.TransientType"]]) {
        pauseAfterStage = NO;
        if (focusStallMs) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, focusStallMs * NSEC_PER_MSEC),
                           dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                dispatch_semaphore_signal(resumeFocus);
            });
        }
        emitMessage(@{@"focusReadPaused": @YES});
        assert(dispatch_semaphore_wait(resumeFocus,
            dispatch_time(DISPATCH_TIME_NOW, focusStallMs * NSEC_PER_MSEC + 5 * NSEC_PER_SEC)) == 0);
    }
    return result ? kAXErrorSuccess : kAXErrorAttributeUnsupported;
}

static AXError getPid(AXUIElementRef element, pid_t *pid) {
    assert((__bridge id)element == fields[focused]);
    *pid = systemFieldPID ?: frontPid;
    return kAXErrorSuccess;
}

static TISInputSourceRef fixtureInputSource(void) {
    return (TISInputSourceRef)CFBridgingRetain([NSData dataWithBytes:&layoutPasteKey length:sizeof(layoutPasteKey)]);
}

static const void *layoutProperty(TISInputSourceRef source, CFStringRef property) {
    assert(CFEqual(property, kTISPropertyUnicodeKeyLayoutData));
    return source;
}

static OSStatus translateKey(const UCKeyboardLayout *layout, UInt16 key, UInt16 action, UInt32 modifiers,
                             UInt32 keyboardType, OptionBits options, UInt32 *dead,
                             UniCharCount maximum, UniCharCount *length, UniChar *result) {
    (void)keyboardType; (void)options; (void)dead; (void)maximum;
    assert(action == kUCKeyActionDisplay && modifiers == cmdKey >> 8);
    CGKeyCode pasteKey;
    memcpy(&pasteKey, layout, sizeof(pasteKey));
    *length = key == pasteKey;
    result[0] = 'v';
    return noErr;
}

static void postKey(CGEventTapLocation tap, CGEventRef event) {
    assert(tap == kCGSessionEventTap && frontPid > 0 && trusted && canPost && !secureInput && !protectedField &&
           !disabledField && !readOnly && !notEditable && !modifiers && !menu);
    [keyCodes addObject:@(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode))];
    assert(CGEventGetFlags(event) == kCGEventFlagMaskCommand);
    if (CGEventGetType(event) == kCGEventKeyUp) {
        assert(keyUps + 1 == keyDowns);
        keyUps++;
        return;
    }
    assert(CGEventGetType(event) == kCGEventKeyDown && keyUps == keyDowns && !consumePaste);
    keyDowns++;
    NSUInteger target = focused;
    consumeAt = timeMs + targetReadDelayMs;
    consumePaste = ^{
        // The receiving editor reads the clipboard later, by reference.
        NSString *text = [clipboard stringForType:NSPasteboardTypeString];
        [reads addObject:text ?: @""];
        [editors[target] readSelectionFromPasteboard:clipboard type:NSPasteboardTypeString];
    };
}

static dispatch_time_t delayTime(dispatch_time_t start, int64_t ns) {
    assert(start == DISPATCH_TIME_NOW && ns >= 0);
    return timeMs + (uint64_t)ns / NSEC_PER_MSEC;
}

static void scheduleSettle(dispatch_time_t deadline, dispatch_queue_t queue, dispatch_block_t block) {
    assert(queue == dispatch_get_main_queue() && !settlePaste);
    settleAt = deadline;
    settlePaste = block;
}

static void advanceTime(uint64_t ms) {
    uint64_t end = timeMs + ms;
    while ((consumePaste && consumeAt <= end) || (settlePaste && settleAt <= end)) {
        if (consumePaste && (!settlePaste || consumeAt < settleAt)) {
            timeMs = consumeAt;
            dispatch_block_t consume = consumePaste;
            consumePaste = nil;
            consume();
        } else {
            timeMs = settleAt;
            dispatch_block_t settle = settlePaste;
            settlePaste = nil;
            settle();
        }
    }
    timeMs = end;
}

#define NSWorkspace FixtureWorkspace
#define NSPasteboard FixturePasteboard
#define AXIsProcessTrusted() (trusted)
#define AXIsProcessTrustedWithOptions(options) (trusted)
#define AXUIElementCopyAttributeValue copyAttribute
#define AXUIElementCreateSystemWide() ((__bridge_retained AXUIElementRef)systemElement)
#define AXUIElementGetPid getPid
#define AXUIElementSetMessagingTimeout(...) ((void)0)
#define IsSecureEventInputEnabled() (secureInput)
#define CGPreflightPostEventAccess() (canPost)
#define GetCurrentKeyModifiers() (modifiers ? cmdKey : 0)
#define CGEventPost postKey
#define TISCopyCurrentKeyboardLayoutInputSource fixtureInputSource
#define TISGetInputSourceProperty layoutProperty
#define UCKeyTranslate translateKey
#define CFAbsoluteTimeGetCurrent() ((CFAbsoluteTime)timeMs / 1000)
#define dispatch_time delayTime
#define dispatch_after scheduleSettle
#define main nativeMain
#include "../../desktop/mac-target.m"
#undef main
#undef NSPasteboard

static NSDictionary *fixtureState(void) {
    NSMutableArray *items = [NSMutableArray array];
    for (NSPasteboardItem *item in clipboard.pasteboardItems) {
        NSMutableDictionary *formats = [NSMutableDictionary dictionary];
        for (NSPasteboardType type in item.types) {
            formats[type] = [type isEqual:NSPasteboardTypeString] || [type isEqual:NSPasteboardTypeHTML]
                ? [item stringForType:type] : [[item dataForType:type] base64EncodedStringWithOptions:0];
        }
        [items addObject:formats];
    }
    return @{@"text": editors[0].string, @"other": editors[1].string, @"external": editors[2].string, @"reads": reads,
             @"keyDowns": @(keyDowns), @"keyUps": @(keyUps), @"keyCodes": keyCodes, @"clipboard": items,
             @"currentHostOnly": @(currentHostOnly)};
}

static void reportQuit(void) {
    if (!quitReport) return;
    NSData *state = [NSJSONSerialization dataWithJSONObject:fixtureState() options:0 error:NULL];
    assert([state writeToFile:quitReport atomically:YES]);
}

static void handleFixture(NSDictionary *message) {
    if (![message[@"action"] isEqual:@"fixture"]) {
        handle(message);
        return;
    }

    NSDictionary *options = message[@"text"];
    if (options[@"trusted"]) trusted = [options[@"trusted"] boolValue];
    if (options[@"canPost"]) canPost = [options[@"canPost"] boolValue];
    if (options[@"secureInput"]) secureInput = [options[@"secureInput"] boolValue];
    if (options[@"protected"]) protectedField = [options[@"protected"] boolValue];
    if (options[@"disabled"]) disabledField = [options[@"disabled"] boolValue];
    if (options[@"readOnly"]) readOnly = [options[@"readOnly"] boolValue];
    if (options[@"notEditable"]) notEditable = [options[@"notEditable"] boolValue];
    if (options[@"modifiers"]) modifiers = [options[@"modifiers"] boolValue];
    if (options[@"focused"]) focused = [options[@"focused"] unsignedIntegerValue];
    if (options[@"frontPid"]) frontPid = [options[@"frontPid"] intValue];
    if (options[@"noField"]) noField = [options[@"noField"] boolValue];
    if (options[@"systemField"]) systemField = [options[@"systemField"] boolValue];
    if (options[@"systemFieldPID"]) systemFieldPID = [options[@"systemFieldPID"] intValue];
    if (options[@"menu"]) menu = [options[@"menu"] boolValue];
    if (options[@"noRole"]) noRole = [options[@"noRole"] boolValue];
    if (options[@"editorEditable"]) editors[0].editable = [options[@"editorEditable"] boolValue];
    if (options[@"failSnapshot"]) failSnapshot = [options[@"failSnapshot"] boolValue];
    if (options[@"failStage"]) failStage = [options[@"failStage"] boolValue];
    if (options[@"failRestore"]) failRestore = [options[@"failRestore"] boolValue];
    if (options[@"switchAppAfterStage"]) switchAppAfterStage = [options[@"switchAppAfterStage"] intValue];
    if (options[@"switchDuringProtection"]) switchDuringProtection = [options[@"switchDuringProtection"] boolValue];
    if (options[@"switchLayoutAfterStage"]) switchLayoutAfterStage = [options[@"switchLayoutAfterStage"] boolValue];
    if (options[@"copyAfterStage"]) copyAfterStage = [options[@"copyAfterStage"] boolValue];
    if (options[@"pauseAfterStage"]) pauseAfterStage = [options[@"pauseAfterStage"] boolValue];
    if (options[@"focusStallMs"]) focusStallMs = [options[@"focusStallMs"] longLongValue];
    if (options[@"quitReport"]) quitReport = options[@"quitReport"];
    if (options[@"copy"]) copyText(options[@"copy"]);
    if ([options[@"clear"] boolValue]) [FixturePasteboard.generalPasteboard clearContents];
    if (options[@"advance"]) {
        advanceTime([options[@"advance"] unsignedLongLongValue]);
        insertWhenReleased();
    }

    emitMessage(@{@"request": message[@"request"], @"fixture": fixtureState()});
}

int main(void) {
    @autoreleasepool {
        [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyProhibited];
        for (NSUInteger i = 0; i < 3; i++) {
            fields[i] = CFBridgingRelease(AXUIElementCreateApplication(103 + (pid_t)i));
            editors[i] = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 440, 240)];
            editors[i].richText = NO;
        }
        editors[0].string = @"left|right";
        editors[0].selectedRange = NSMakeRange(4, 1);
        editors[1].string = @"other";
        editors[2].string = @"external";
        systemElement = CFBridgingRelease(AXUIElementCreateApplication(105));

        clipboard = [NSPasteboard pasteboardWithUniqueName];
        NSPasteboardItem *first = [NSPasteboardItem new];
        [first setString:@"existing" forType:NSPasteboardTypeString];
        [first setString:@"<b>existing</b>" forType:NSPasteboardTypeHTML];
        NSPasteboardItem *second = [NSPasteboardItem new];
        [second setData:[NSData dataWithBytes:"\x00\xff" length:2] forType:@"net.example.binary"];
        [FixturePasteboard.generalPasteboard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
        assert(([clipboard writeObjects:@[first, second]]));
        reads = [NSMutableArray array];
        keyCodes = [NSMutableArray array];
        resumeFocus = dispatch_semaphore_create(0);
        assert(atexit(reportQuit) == 0);
        readRequests(^(NSDictionary *message) {
            // Run this signal on the stdin reader while the AX call is blocked.
            if ([message[@"action"] isEqual:@"resume-focus"]) dispatch_semaphore_signal(resumeFocus);
            else dispatch_async(dispatch_get_main_queue(), ^{ handleFixture(message); });
        });
        [NSApplication.sharedApplication run];
    }
    return 0;
}
