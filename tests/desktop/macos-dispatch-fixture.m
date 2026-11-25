#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <assert.h>

// Substitute the OS calls for this test executable only. Both documents
// belong to the same simulated frontmost process.
@interface FixtureWorkspace : NSObject
@property (readonly) NSRunningApplication *frontmostApplication;
@property (readonly) NSNotificationCenter *notificationCenter;
@property (readonly) pid_t processIdentifier;
@property (readonly) NSString *bundleIdentifier;
+ (instancetype)sharedWorkspace;
@end

static BOOL browser;
static BOOL readOnly;
static BOOL secure;
static BOOL trusted = YES;
static BOOL modifiers;
static BOOL operationAvailable = YES;
static BOOL chrome;
static BOOL singleLine;
static BOOL foreignRange;
static BOOL focusBeforeConsumption;
static BOOL moveCaretBeforeConsumption;
static BOOL delayWasObserved;
static NSInteger editLimit = -1;
static NSMutableArray<NSString *> *dispatches;

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSRunningApplication *)frontmostApplication { return (NSRunningApplication *)self; }
- (NSNotificationCenter *)notificationCenter { return NSNotificationCenter.defaultCenter; }
- (pid_t)processIdentifier { return 100; }
- (NSString *)bundleIdentifier {
    if (chrome) return @"com.google.Chrome";
    return browser ? @"com.apple.Safari" : @"com.apple.TextEdit";
}
@end

static id browserDocument;
static id windows[2];
static id fields[2];
static NSString *documents[2] = {@"left|right", @"other"};
static CFRange selection;
static NSUInteger selectionReads;
static NSUInteger focused;
static BOOL switchOnSecondSelection;
static NSUInteger focusReads;
static BOOL switchOnFinalFocus;

typedef struct {
    NSUInteger field;
    CFIndex offset;
} FixtureMarker;

static AXError copyAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    NSString *key = (__bridge NSString *)attribute;
    id object = (__bridge id)element;
    id result = nil;
    if ([key isEqual:@"AXFocusedWindow"]) result = windows[focused];
    else if ([key isEqual:@"AXFocusedUIElement"]) result = fields[focused];
    else if ([key isEqual:@"AXRole"]) {
        if (object == fields[0] || object == fields[1]) result = singleLine ? @"AXTextField" : @"AXTextArea";
        else result = browser && object == browserDocument ? @"AXWebArea" : @"AXScrollArea";
    }
    else if ([key isEqual:@"AXSubrole"] && object == windows[0]) result = @"AXStandardWindow";
    else if ([key isEqual:@"AXSubrole"] && object == fields[0] && secure) result = @"AXSecureTextField";
    else if ([key isEqual:@"AXEnabled"]) result = @YES;
    else if ([key isEqual:@"AXFocused"]) result = @(object == fields[focused]);
    else if ([key isEqual:@"AXParent"]) result = browser ? browserDocument : windows[0];
    else if ([key isEqual:@"AXWindow"]) result = windows[0];
    else if ([key isEqual:@"AXValue"]) result = documents[object == fields[1]];
    else if ([key isEqual:@"AXSelectedTextMarkerRange"]) {
        FixtureMarker point = { .field = foreignRange ? 1 : focused, .offset = selection.location };
        AXTextMarkerRef marker = AXTextMarkerCreate(NULL, (const UInt8 *)&point, sizeof(point));
        result = CFBridgingRelease(AXTextMarkerRangeCreate(NULL, marker, marker));
        CFRelease(marker);
    }
    else if ([key isEqual:@"AXSelectedTextRange"]) {
        // Simulate the focus change on the final selection read. AX's
        // observer callback has yet to run when the write is dispatched.
        if (++selectionReads == 2 && switchOnSecondSelection) focused = 1;
        *value = AXValueCreate(kAXValueTypeCFRange, &selection);
        return kAXErrorSuccess;
    }
    *value = CFBridgingRetain(result);
    return result ? kAXErrorSuccess : kAXErrorAttributeUnsupported;
}

static AXError copyFocus(AXUIElementRef element, CFArrayRef keys, AXCopyMultipleAttributeOptions options,
                         CFArrayRef *values) {
    (void)element;
    (void)options;
    assert([(__bridge NSArray *)keys isEqual:(@[@"AXFocusedWindow", @"AXFocusedUIElement"])]);
    if (++focusReads == 3 && switchOnFinalFocus) focused = 1;
    *values = CFBridgingRetain(@[windows[focused], fields[focused]]);
    return kAXErrorSuccess;
}

static AXError selectedTextWritable(AXUIElementRef element, CFStringRef key, Boolean *allowed) {
    *allowed = (__bridge id)element == fields[0] && !readOnly &&
        CFEqual(key, browser ? kAXValueAttribute : kAXSelectedTextAttribute);
    return kAXErrorSuccess;
}

static AXError editDocument(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
    assert(!browser && CFEqual(key, kAXSelectedTextAttribute));
    NSUInteger document = (__bridge id)element == fields[1];
    NSString *text = (__bridge NSString *)value;
    documents[document] = [documents[document] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)selection.location, (NSUInteger)selection.length) withString:text];
    selection = CFRangeMake(selection.location + (CFIndex)text.length, 0);
    return kAXErrorSuccess;
}

static FixtureMarker fixtureMarker(AXTextMarkerRef marker) {
    assert(AXTextMarkerGetLength(marker) == sizeof(FixtureMarker));
    FixtureMarker point;
    memcpy(&point, AXTextMarkerGetBytePtr(marker), sizeof(point));
    return point;
}

static AXError copyParameterizedNames(AXUIElementRef element, CFArrayRef *names) {
    assert((__bridge id)element == fields[focused]);
    *names = CFBridgingRetain(operationAvailable ? @[@"AXTextOperation"] : @[]);
    return kAXErrorSuccess;
}

static AXError copyParameterized(AXUIElementRef element, CFStringRef key, CFTypeRef input, CFTypeRef *value) {
    id parameter = (__bridge id)input;
    if (CFEqual(key, CFSTR("AXUIElementForTextMarker"))) {
        FixtureMarker point = fixtureMarker((__bridge AXTextMarkerRef)parameter);
        *value = CFBridgingRetain(fields[point.field]);
        return kAXErrorSuccess;
    }

    assert(CFEqual(key, CFSTR("AXTextOperation")) && browser && trusted && !modifiers);
    assert(!secure && !readOnly && operationAvailable && (__bridge id)element == fields[0]);
    assert([parameter[@"AXTextOperationType"] isEqual:@"TextOperationReplacePreserveCase"]);
    assert([parameter[@"AXTextOperationSmartReplace"] isEqual:@NO]);
    id range = [parameter[@"AXTextOperationMarkerRanges"] firstObject];
    AXTextMarkerRef start = AXTextMarkerRangeCopyStartMarker((__bridge AXTextMarkerRangeRef)range);
    FixtureMarker marker = fixtureMarker(start);
    CFRelease(start);
    assert(fields[marker.field] == (__bridge id)element);
    NSUInteger document = marker.field;
    NSUInteger offset = (NSUInteger)marker.offset;
    NSString *text = parameter[@"AXTextOperationReplacementString"];
    [dispatches addObject:text];
    *value = CFBridgingRetain(@[text]);

    if (editLimit >= 0 && text.length > (NSUInteger)editLimit) {
        text = [text substringToIndex:(NSUInteger)editLimit];
    }
    if (!text.length) return kAXErrorSuccess;
    void (^consume)(void) = ^{
        documents[document] = [documents[document] stringByReplacingCharactersInRange:NSMakeRange(offset, 0) withString:text];
        if (focused == document) selection = CFRangeMake((CFIndex)(offset + text.length), 0);
    };
    if (focusBeforeConsumption || moveCaretBeforeConsumption) {
        // Delay consumption beyond the helper's post-dispatch read. A
        // process-targeted event here would use the newly focused field.
        if (focusBeforeConsumption) focused = 1;
        else selection = CFRangeMake(0, 0);
        delayWasObserved = NO;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            consume();
            delayWasObserved = YES;
        });
    } else {
        consume();
    }
    return kAXErrorSuccess;
}

#define main packagedHelperMain
#define NSWorkspace FixtureWorkspace
#define AXIsProcessTrusted() trusted
#define AXIsProcessTrustedWithOptions(options) ((void)(options), trusted)
#define GetCurrentKeyModifiers() (modifiers ? cmdKey : 0)
#define AXObserverCreate(pid, callback, observer) AXObserverCreate(getpid(), callback, observer)
#define AXObserverAddNotification(...) kAXErrorSuccess
#define AXUIElementCopyAttributeValue copyAttribute
#define AXUIElementCopyMultipleAttributeValues copyFocus
#define AXUIElementIsAttributeSettable selectedTextWritable
#define AXUIElementSetAttributeValue editDocument
#define AXUIElementCopyParameterizedAttributeNames copyParameterizedNames
#define AXUIElementCopyParameterizedAttributeValue copyParameterized
#include "../../desktop/mac-target.m"
#undef main

static void runBrowserFixture(void) {
    browser = YES;
    browserDocument = CFBridgingRelease(AXUIElementCreateApplication(105));
    windows[1] = windows[0];
    selection = CFRangeMake(5, 0);
    dispatches = [NSMutableArray array];
    dispatch_source_t poll = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(poll, DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(poll, ^{ insertWhenReleased(); });
    dispatch_resume(poll);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char *line = NULL;
        size_t capacity = 0;
        ssize_t length;
        while ((length = getline(&line, &capacity, stdin)) >= 0) {
            @autoreleasepool {
                NSDictionary *message = [NSJSONSerialization JSONObjectWithData:
                    [NSData dataWithBytes:line length:(NSUInteger)length] options:0 error:NULL];
                dispatch_sync(dispatch_get_main_queue(), ^{
                    if ([message[@"action"] isEqual:@"fixture"]) {
                        NSDictionary *options = message[@"text"];
                        readOnly = [options[@"readOnly"] boolValue];
                        secure = [options[@"secure"] boolValue];
                        trusted = ![options[@"denyAccessibility"] boolValue];
                        switchOnFinalFocus = [options[@"stale"] boolValue];
                        focusReads = 0;
                        operationAvailable = ![options[@"missingOperation"] boolValue];
                        chrome = [options[@"chrome"] boolValue];
                        singleLine = [options[@"singleLine"] boolValue];
                        foreignRange = [options[@"foreignRange"] boolValue];
                        focusBeforeConsumption = [options[@"focusBeforeConsumption"] boolValue];
                        moveCaretBeforeConsumption = [options[@"moveCaretBeforeConsumption"] boolValue];
                        editLimit = options[@"editLimit"] ? [options[@"editLimit"] integerValue] : -1;
                        modifiers = [options[@"held"] boolValue];
                        if ([options[@"restoreFocus"] boolValue]) focused = 0;
                        insertWhenReleased();
                        emitMessage(@{@"request": message[@"request"], @"fixture": @{
                            @"text": documents[0], @"other": documents[1], @"dispatches": dispatches,
                            @"focused": @(focused), @"consumed": @(delayWasObserved),
                        }});
                    } else {
                        handle(message);
                    }
                });
            }
        }
        free(line);
        dispatch_async(dispatch_get_main_queue(), ^{ exit(0); });
    });
    [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApplication.sharedApplication run];
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        // Real CF-backed AX references provide distinct identities. The
        // substituted functions above make no requests to these PIDs.
        windows[0] = CFBridgingRelease(AXUIElementCreateApplication(101));
        windows[1] = CFBridgingRelease(AXUIElementCreateApplication(102));
        fields[0] = CFBridgingRelease(AXUIElementCreateApplication(103));
        fields[1] = CFBridgingRelease(AXUIElementCreateApplication(104));
        if (argc == 2 && strcmp(argv[1], "browser") == 0) {
            runBrowserFixture();
            return 0;
        }
        bound = [Binding new];
        bound.pid = 100;
        bound.application = CFBridgingRelease(AXUIElementCreateApplication(bound.pid));
        bound.window = windows[0];
        bound.area = fields[0];

        selection = CFRangeMake(5, 0);
        switchOnSecondSelection = YES;
        pendingRequest = @1;
        pendingText = @"東京🙂";
        waitingForRelease = YES;
        insertWhenReleased();
        assert(focused == 1 && !pendingRequest);
        assert([documents[0] isEqual:@"left|right"] && [documents[1] isEqual:@"other"]);

        focused = 0;
        switchOnSecondSelection = NO;
        pendingRequest = @2;
        pendingText = @"東京🙂";
        waitingForRelease = YES;
        insertWhenReleased();
        assert(!pendingRequest);
        assert([documents[0] isEqual:@"left|東京🙂right"] && [documents[1] isEqual:@"other"]);
    }
}
