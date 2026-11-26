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
@property (readonly) NSURL *bundleURL;
+ (instancetype)sharedWorkspace;
@end

static BOOL browser;
static BOOL pasteOnly;
static BOOL alternateApplication;
static BOOL canPostEvents = YES;
static BOOL disabledField;
static BOOL failWrite;
static NSPasteboard *clipboard;
static NSUInteger pasteKeyUps;
static NSString *copyOnPaste;
static BOOL noObserverNotifications;
static BOOL singleLine;
static BOOL protectedField;
static BOOL noEditingOperation;
static NSUInteger limit;
static BOOL trusted = YES;
static BOOL readOnly;
static BOOL modifiers;
static NSUInteger writes;
static NSMutableArray<NSString *> *browserChunks;

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSRunningApplication *)frontmostApplication { return (NSRunningApplication *)self; }
- (NSNotificationCenter *)notificationCenter { return NSNotificationCenter.defaultCenter; }
- (pid_t)processIdentifier { return alternateApplication ? 200 : 100; }
- (NSString *)bundleIdentifier {
    return alternateApplication ? @"net.example.second-editor" : @"net.example.first-editor";
}
- (NSURL *)bundleURL {
    return [NSURL fileURLWithPath:alternateApplication ? @"/tmp/Editor.app" : @"/Applications/Example.app"];
}
@end

static id windows[2];
static id fields[2];
static NSString *documents[2] = {@"left|right", @"other"};
static CFRange selection;
static NSUInteger selectionReads;
static NSUInteger focused;
static BOOL switchOnSecondSelection;
static BOOL readOnlyOnSecondSelection;
static BOOL denyAccessibilityOnSecondSelection;
static BOOL moveCaretOnFinalEditability;
static BOOL changeValueOnFinalEditability;
static BOOL pauseFinalFocus;
static NSUInteger editabilityChecks;
static dispatch_semaphore_t resumeFocus;

static void emitMessage(NSDictionary *message);

static AXError copyAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    NSString *key = (__bridge NSString *)attribute;
    id object = (__bridge id)element;
    id result = nil;
    if ([key isEqual:@"AXFocusedWindow"]) result = windows[focused];
    else if ([key isEqual:@"AXFocusedUIElement"]) result = fields[focused];
    else if ([key isEqual:@"AXRole"]) {
        if (object == fields[0] || object == fields[1]) result = singleLine ? @"AXTextField" : @"AXTextArea";
        else result = @"AXGroup";
    }
    else if ([key isEqual:@"AXSubrole"] && protectedField) result = @"AXSecureTextField";
    else if ([key isEqual:@"AXEnabled"]) result = @(!disabledField);
    else if ([key isEqual:@"AXFocused"]) result = @(object == fields[focused]);
    else if ([key isEqual:@"AXValue"]) result = documents[object == fields[1]];
    else if ([key isEqual:@"AXSelectedTextRange"]) {
        // Change state while capturing an explicit range, without an observer callback.
        if (++selectionReads == 2) {
            if (switchOnSecondSelection) focused = 1;
            if (readOnlyOnSecondSelection) readOnly = YES;
            if (denyAccessibilityOnSecondSelection) trusted = NO;
        }
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
    *values = CFBridgingRetain(@[windows[focused], fields[focused]]);
    if (pauseFinalFocus && editabilityChecks >= 2) {
        pauseFinalFocus = NO;
        emitMessage(@{@"focusReadPaused": @YES});
        assert(dispatch_semaphore_wait(resumeFocus,
            dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0);
    }
    return kAXErrorSuccess;
}

static AXError textWritable(AXUIElementRef element, CFStringRef key, Boolean *allowed) {
    if (CFEqual(key, kAXValueAttribute) && ++editabilityChecks == 2) {
        if (moveCaretOnFinalEditability) {
            moveCaretOnFinalEditability = NO;
            selection = CFRangeMake(2, 0);
        }
        if (changeValueOnFinalEditability) {
            changeValueOnFinalEditability = NO;
            documents[0] = @"left|RIGHT";
        }
    }
    *allowed = (__bridge id)element == fields[0] && !readOnly && !noEditingOperation &&
        CFEqual(key, (browser || pasteOnly) ? kAXValueAttribute : kAXSelectedTextAttribute);
    return kAXErrorSuccess;
}

static void applyEdit(NSUInteger document, CFRange range, NSString *text) {
    if (singleLine) text = [text stringByReplacingOccurrencesOfString:@"\n" withString:@""];
    if (limit && text.length > limit) text = [text substringToIndex:limit];
    documents[document] = [documents[document] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)range.location, (NSUInteger)range.length) withString:text];
    selection = CFRangeMake(range.location + (CFIndex)text.length, 0);
}

static AXError editDocument(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
    assert(!browser && !pasteOnly && trusted && !readOnly && !modifiers && CFEqual(key, kAXSelectedTextAttribute));
    writes++;
    if (failWrite) return kAXErrorFailure;
    applyEdit((__bridge id)element == fields[1], selection, (__bridge NSString *)value);
    return kAXErrorSuccess;
}

static AXError copyParameterizedNames(AXUIElementRef element, CFArrayRef *names) {
    assert((__bridge id)element == fields[focused]);
    *names = CFBridgingRetain(!browser ? @[@"AXTextOperation"] : @[@"AXReplaceRangeWithText", @"AXTextOperation"]);
    return kAXErrorSuccess;
}

static AXError copyParameterized(AXUIElementRef element, CFStringRef key, CFTypeRef input, CFTypeRef *value) {
    // Reject any fallback to a generic accessibility text event. The older
    // AXTextOperation could redirect after selection changes or submit a form.
    assert(browser && CFEqual(key, CFSTR("AXReplaceRangeWithText")));
    assert((__bridge id)element == fields[focused] && focused == 0);
    assert(!modifiers && !protectedField);
    NSDictionary *parameter = (__bridge NSDictionary *)input;
    NSString *text = parameter[@"AXReplacementText"];
    CFRange range;
    assert(AXValueGetValue((__bridge AXValueRef)parameter[@"AXReplacementRange"], kAXValueTypeCFRange, &range));
    // WebKit applies the supplied range independently of the current caret.
    [browserChunks addObject:text];
    writes++;
    *value = CFRetain(kCFBooleanTrue);
    if (failWrite) return kAXErrorFailure;
    if (trusted && !readOnly) applyEdit(0, range, text);
    return kAXErrorSuccess;
}

@interface NSPasteboard (DispatchFixture)
+ (NSPasteboard *)fixtureGeneralPasteboard;
@end
@implementation NSPasteboard (DispatchFixture)
+ (NSPasteboard *)fixtureGeneralPasteboard { return clipboard; }
@end

static void postPasteEvent(pid_t pid, CGEventRef event) {
    assert(pasteOnly && pid == (alternateApplication ? 200 : 100));
    assert(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == kVK_ANSI_V);
    assert(CGEventGetFlags(event) == kCGEventFlagMaskCommand);
    if (CGEventGetType(event) == kCGEventKeyUp) {
        pasteKeyUps++;
        return;
    }
    assert(CGEventGetType(event) == kCGEventKeyDown);
    NSString *text = [clipboard stringForType:NSPasteboardTypeString];
    assert(text && trusted && !protectedField && !readOnly && !modifiers);
    writes++;
    applyEdit(focused, selection, text);
    if (copyOnPaste) {
        [clipboard clearContents];
        [clipboard setString:copyOnPaste forType:NSPasteboardTypeString];
    }
}

#define main packagedHelperMain
#define NSWorkspace FixtureWorkspace
#define AXIsProcessTrusted() trusted
#define AXIsProcessTrustedWithOptions(options) ((void)(options), trusted)
#define AXObserverCreate(pid, callback, observer) AXObserverCreate(getpid(), callback, observer)
#define GetCurrentKeyModifiers() (modifiers ? cmdKey : 0)
#define AXObserverAddNotification(...) (noObserverNotifications ? kAXErrorNotificationUnsupported : kAXErrorSuccess)
#define AXUIElementCopyAttributeValue copyAttribute
#define AXUIElementCopyMultipleAttributeValues copyFocus
#define AXUIElementIsAttributeSettable textWritable
#define AXUIElementSetAttributeValue editDocument
#define AXUIElementCopyParameterizedAttributeNames copyParameterizedNames
#define AXUIElementCopyParameterizedAttributeValue copyParameterized
#define generalPasteboard fixtureGeneralPasteboard
#define CGPreflightPostEventAccess() canPostEvents
#define CGEventPostToPid postPasteEvent
#include "../../desktop/mac-target.m"
#undef generalPasteboard
#undef main

static void handleFixture(NSDictionary *message) {
    if ([message[@"action"] isEqual:@"resume-focus"]) {
        respond(message[@"request"], nil);
        return;
    }
    if (![message[@"action"] isEqual:@"fixture"]) {
        handle(message);
        return;
    }
    NSDictionary *options = message[@"text"];
    singleLine = [options[@"singleLine"] boolValue];
    protectedField = [options[@"protectedField"] boolValue];
    disabledField = [options[@"disabledField"] boolValue];
    noObserverNotifications = [options[@"noObserverNotifications"] boolValue];
    canPostEvents = ![options[@"denyPostEvents"] boolValue];
    failWrite = [options[@"failWrite"] boolValue];
    noEditingOperation = [options[@"noEditingOperation"] boolValue];
    limit = [options[@"limit"] unsignedIntegerValue];
    if (options[@"focused"]) focused = [options[@"focused"] unsignedIntegerValue];
    switchOnSecondSelection = [options[@"switchOnSecondSelection"] boolValue];
    readOnlyOnSecondSelection = [options[@"readOnlyOnSecondSelection"] boolValue];
    denyAccessibilityOnSecondSelection = [options[@"denyAccessibilityOnSecondSelection"] boolValue];
    moveCaretOnFinalEditability = [options[@"moveCaretOnFinalEditability"] boolValue];
    changeValueOnFinalEditability = [options[@"changeValueOnFinalEditability"] boolValue];
    if (options[@"selectionLength"]) selection.length = [options[@"selectionLength"] integerValue];
    pauseFinalFocus = [options[@"pauseFinalFocus"] boolValue];
    editabilityChecks = 0;
    selectionReads = 0;
    trusted = ![options[@"denyAccessibility"] boolValue];
    readOnly = [options[@"readOnly"] boolValue];
    modifiers = [options[@"held"] boolValue];
    copyOnPaste = options[@"copyOnPaste"];
    NSMutableDictionary *state = [@{
        @"text": documents[0], @"other": documents[1], @"writes": @(writes),
        @"focused": @(focused),
    } mutableCopy];
    if (browser) state[@"chunks"] = browserChunks;
    if (pasteOnly) {
        NSMutableArray *items = [NSMutableArray array];
        for (NSPasteboardItem *item in clipboard.pasteboardItems) {
            NSMutableDictionary *types = [NSMutableDictionary dictionary];
            for (NSPasteboardType type in item.types) types[type] = [item stringForType:type];
            [items addObject:types];
        }
        state[@"clipboard"] = items;
        state[@"pasteKeyUps"] = @(pasteKeyUps);
    }
    emitMessage(@{@"request": message[@"request"], @"fixture": state});
}

static void runFixture(void) {
    if (browser) {
        windows[1] = windows[0];
        browserChunks = [NSMutableArray array];
    }
    if (pasteOnly) {
        clipboard = [NSPasteboard pasteboardWithUniqueName];
        NSPasteboardItem *first = [NSPasteboardItem new];
        [first setString:@"existing" forType:NSPasteboardTypeString];
        [first setString:@"<b>existing</b>" forType:NSPasteboardTypeHTML];
        NSPasteboardItem *second = [NSPasteboardItem new];
        [second setString:@"second" forType:NSPasteboardTypeString];
        assert(([clipboard writeObjects:@[first, second]]));
    }
    selection = CFRangeMake(5, 0);
    resumeFocus = dispatch_semaphore_create(0);
    dispatch_source_t poll = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(poll, DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(poll, ^{ insertWhenReleased(); });
    dispatch_resume(poll);
    readRequests(^(NSDictionary *message) {
        // This command follows release on stdin and runs while the AX call is paused.
        if ([message[@"action"] isEqual:@"resume-focus"]) {
            dispatch_semaphore_signal(resumeFocus);
        }
        dispatch_async(dispatch_get_main_queue(), ^{ handleFixture(message); });
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
        assert(argc == 2 || argc == 3);
        browser = strcmp(argv[1], "range") == 0;
        pasteOnly = strcmp(argv[1], "paste") == 0;
        alternateApplication = argc == 3;
        runFixture();
    }
}
