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
static BOOL keyboard = YES;
static BOOL modifiers;
static NSUInteger changeFocusAtDispatch;
static BOOL replaceClipboard;
static NSInteger pasteLimit = -1;
static NSMutableArray<NSString *> *dispatches;
static NSPasteboard *testBoard;

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSRunningApplication *)frontmostApplication { return (NSRunningApplication *)self; }
- (NSNotificationCenter *)notificationCenter { return NSNotificationCenter.defaultCenter; }
- (pid_t)processIdentifier { return 100; }
- (NSString *)bundleIdentifier { return browser ? @"com.google.Chrome" : @"com.apple.TextEdit"; }
@end

@interface NSPasteboard (DispatchFixture)
+ (NSPasteboard *)fixturePasteboard;
@end

@implementation NSPasteboard (DispatchFixture)
+ (NSPasteboard *)fixturePasteboard { return testBoard; }
@end

static id browserDocument;
static id windows[2];
static id fields[2];
static NSString *documents[2] = {@"left|right", @"other"};
static CFRange selection;
static NSUInteger selectionReads;
static NSUInteger focused;
static BOOL switchOnSecondSelection;

static AXError copyAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    NSString *key = (__bridge NSString *)attribute;
    id object = (__bridge id)element;
    id result = nil;
    if ([key isEqual:@"AXFocusedWindow"]) result = windows[focused];
    else if ([key isEqual:@"AXFocusedUIElement"]) result = fields[focused];
    else if ([key isEqual:@"AXRole"]) {
        if (object == fields[0]) result = @"AXTextArea";
        else result = browser && object == browserDocument ? @"AXWebArea" : @"AXScrollArea";
    }
    else if ([key isEqual:@"AXSubrole"] && object == windows[0]) result = @"AXStandardWindow";
    else if ([key isEqual:@"AXSubrole"] && object == fields[0] && secure) result = @"AXSecureTextField";
    else if ([key isEqual:@"AXEnabled"]) result = @YES;
    else if ([key isEqual:@"AXFocused"]) result = @(object == fields[focused]);
    else if ([key isEqual:@"AXParent"]) result = browser ? browserDocument : windows[0];
    else if ([key isEqual:@"AXWindow"]) result = windows[0];
    else if ([key isEqual:@"AXValue"]) result = documents[object == fields[1]];
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
    if (changeFocusAtDispatch && [testBoard.pasteboardItems.firstObject.types containsObject:@"org.nspasteboard.TransientType"]) {
        // Change fields on the final focus snapshot, without an observer
        // callback. Both fields remain in the same window and process.
        if (focused == 0 && changeFocusAtDispatch++ > 1) focused = 1;
    }
    *values = CFBridgingRetain(@[windows[focused], fields[focused]]);
    return kAXErrorSuccess;
}

static AXError selectedTextWritable(AXUIElementRef element, CFStringRef key, Boolean *allowed) {
    *allowed = (__bridge id)element == fields[0] && !readOnly &&
        CFEqual(key, browser ? kAXValueAttribute : kAXSelectedTextAttribute);
    return kAXErrorSuccess;
}

static AXError editDocument(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
    assert(!browser);
    assert(CFEqual(key, kAXSelectedTextAttribute));
    NSUInteger document = (__bridge id)element == fields[1];
    NSString *text = (__bridge NSString *)value;
    documents[document] = [documents[document] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)selection.location, (NSUInteger)selection.length) withString:text];
    selection = CFRangeMake(selection.location + (CFIndex)text.length, 0);
    return kAXErrorSuccess;
}

static void postPaste(pid_t pid, CGEventRef event) {
    assert(pid == 100 && CGEventGetFlags(event) == kCGEventFlagMaskCommand &&
        CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == kVK_ANSI_V);
    assert(focused == 0 && !readOnly && !secure && keyboard && !modifiers);
    if (CGEventGetType(event) == kCGEventKeyUp) return;
    assert(CGEventGetType(event) == kCGEventKeyDown);
    NSString *text = [testBoard stringForType:NSPasteboardTypeString];
    assert(text);
    [dispatches addObject:text];
    if (pasteLimit >= 0 && text.length > (NSUInteger)pasteLimit) text = [text substringToIndex:(NSUInteger)pasteLimit];
    documents[0] = [documents[0] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)selection.location, (NSUInteger)selection.length) withString:text];
    selection = CFRangeMake(selection.location + (CFIndex)text.length, 0);
    if (replaceClipboard) {
        [testBoard clearContents];
        [testBoard setString:@"new user copy" forType:NSPasteboardTypeString];
    }
}

#define main packagedHelperMain
#define NSWorkspace FixtureWorkspace
#define AXIsProcessTrusted() YES
#define CGPreflightPostEventAccess() keyboard
#define CGRequestPostEventAccess() ((void)0)
#define GetCurrentKeyModifiers() (modifiers ? cmdKey : 0)
#define CGEventPostToPid postPaste
#define AXObserverCreate(pid, callback, observer) AXObserverCreate(getpid(), callback, observer)
#define AXObserverAddNotification(...) kAXErrorSuccess
#define AXUIElementCopyAttributeValue copyAttribute
#define AXUIElementCopyMultipleAttributeValues copyFocus
#define AXUIElementIsAttributeSettable selectedTextWritable
#define AXUIElementSetAttributeValue editDocument
#define generalPasteboard fixturePasteboard
#include "../../desktop/mac-target.m"
#undef main

static void runBrowserFixture(void) {
    browser = YES;
    browserDocument = CFBridgingRelease(AXUIElementCreateApplication(105));
    windows[1] = windows[0];
    selection = CFRangeMake(5, 0);
    dispatches = [NSMutableArray array];
    testBoard = NSPasteboard.pasteboardWithUniqueName;
    NSPasteboardItem *original = [NSPasteboardItem new];
    [original setString:@"existing copy" forType:NSPasteboardTypeString];
    [original setData:[@"binary data" dataUsingEncoding:NSUTF8StringEncoding] forType:@"fixture.binary"];
    assert([testBoard writeObjects:@[original]]);
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
                        keyboard = ![options[@"denyKeyboard"] boolValue];
                        changeFocusAtDispatch = [options[@"stale"] boolValue];
                        replaceClipboard = [options[@"replaceClipboard"] boolValue];
                        pasteLimit = options[@"pasteLimit"] ? [options[@"pasteLimit"] integerValue] : -1;
                        modifiers = [options[@"held"] boolValue];
                        insertWhenReleased();
                        NSData *data = [testBoard dataForType:@"fixture.binary"];
                        emitMessage(@{@"request": message[@"request"], @"fixture": @{
                            @"text": documents[0], @"other": documents[1], @"dispatches": dispatches,
                            @"clipboard": [testBoard stringForType:NSPasteboardTypeString] ?: @"",
                            @"binary": data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"",
                            @"focused": @(focused),
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
