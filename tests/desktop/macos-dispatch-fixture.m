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
static BOOL singleLine;
static BOOL protectedField;
static BOOL noRangeReplacement;
static BOOL moveCaretOnly;
static NSUInteger limit;
static BOOL trusted = YES;
static BOOL readOnly;
static BOOL modifiers;
static BOOL dropWrite;
static NSUInteger writes;
static NSMutableArray<NSString *> *browserChunks;

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSRunningApplication *)frontmostApplication { return (NSRunningApplication *)self; }
- (NSNotificationCenter *)notificationCenter { return NSNotificationCenter.defaultCenter; }
- (pid_t)processIdentifier { return 100; }
- (NSString *)bundleIdentifier {
    return browser ? @"com.apple.Safari" : @"com.apple.TextEdit";
}
- (NSURL *)bundleURL {
    return [NSURL fileURLWithPath:browser ? @"/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app" : @"/System/Applications/TextEdit.app"];
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
    else if ([key isEqual:@"AXSubrole"] && protectedField) result = @"AXSecureTextField";
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
    *values = CFBridgingRetain(@[windows[focused], fields[focused]]);
    return kAXErrorSuccess;
}

static AXError textWritable(AXUIElementRef element, CFStringRef key, Boolean *allowed) {
    *allowed = (__bridge id)element == fields[0] && !readOnly &&
        CFEqual(key, browser ? kAXValueAttribute : kAXSelectedTextAttribute);
    return kAXErrorSuccess;
}

static AXError editDocument(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
    assert(!browser && trusted && !readOnly && !modifiers && CFEqual(key, kAXSelectedTextAttribute));
    writes++;
    if (dropWrite) return kAXErrorSuccess;
    NSUInteger document = (__bridge id)element == fields[1];
    NSString *text = (__bridge NSString *)value;
    documents[document] = [documents[document] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)selection.location, (NSUInteger)selection.length) withString:text];
    selection = CFRangeMake(selection.location + (CFIndex)text.length, 0);
    return kAXErrorSuccess;
}

static AXError copyParameterizedNames(AXUIElementRef element, CFArrayRef *names) {
    assert((__bridge id)element == fields[focused]);
    *names = CFBridgingRetain(noRangeReplacement ? @[@"AXTextOperation"] : @[@"AXReplaceRangeWithText", @"AXTextOperation"]);
    return kAXErrorSuccess;
}

static AXError copyParameterized(AXUIElementRef element, CFStringRef key, CFTypeRef input, CFTypeRef *value) {
    // Reject any fallback to a generic accessibility text event. The older
    // AXTextOperation could redirect after selection changes or submit a form.
    assert(browser && CFEqual(key, CFSTR("AXReplaceRangeWithText")));
    assert((__bridge id)element == fields[focused] && focused == 0);
    assert(trusted && !readOnly && !modifiers && !protectedField);
    NSDictionary *parameter = (__bridge NSDictionary *)input;
    NSString *text = parameter[@"AXReplacementText"];
    CFRange range;
    assert(AXValueGetValue((__bridge AXValueRef)parameter[@"AXReplacementRange"], kAXValueTypeCFRange, &range));
    assert(range.location == selection.location && range.length == selection.length);
    [browserChunks addObject:text];
    writes++;
    *value = CFRetain(kCFBooleanTrue);
    if (moveCaretOnly) selection = CFRangeMake(range.location + 1, 0);
    if (dropWrite || moveCaretOnly) return kAXErrorSuccess;
    if (singleLine) text = [text stringByReplacingOccurrencesOfString:@"\n" withString:@""];
    if (limit && text.length > limit) text = [text substringToIndex:limit];
    documents[0] = [documents[0] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)range.location, (NSUInteger)range.length) withString:text];
    selection = CFRangeMake(range.location + (CFIndex)text.length, 0);
    return kAXErrorSuccess;
}

#define main packagedHelperMain
#define NSWorkspace FixtureWorkspace
#define AXIsProcessTrusted() trusted
#define AXIsProcessTrustedWithOptions(options) ((void)(options), trusted)
#define AXObserverCreate(pid, callback, observer) AXObserverCreate(getpid(), callback, observer)
#define GetCurrentKeyModifiers() (modifiers ? cmdKey : 0)
#define AXObserverAddNotification(...) kAXErrorSuccess
#define AXUIElementCopyAttributeValue copyAttribute
#define AXUIElementCopyMultipleAttributeValues copyFocus
#define AXUIElementIsAttributeSettable textWritable
#define AXUIElementSetAttributeValue editDocument
#define AXUIElementCopyParameterizedAttributeNames copyParameterizedNames
#define AXUIElementCopyParameterizedAttributeValue copyParameterized
#include "../../desktop/mac-target.m"
#undef main

static void runFixture(void) {
    if (browser) {
        browserDocument = CFBridgingRelease(AXUIElementCreateApplication(105));
        windows[1] = windows[0];
        browserChunks = [NSMutableArray array];
    }
    selection = CFRangeMake(5, 0);
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
                        singleLine = [options[@"singleLine"] boolValue];
                        protectedField = [options[@"protectedField"] boolValue];
                        noRangeReplacement = [options[@"noRangeReplacement"] boolValue];
                        moveCaretOnly = [options[@"moveCaretOnly"] boolValue];
                        limit = [options[@"limit"] unsignedIntegerValue];
                        if (options[@"focused"]) focused = [options[@"focused"] unsignedIntegerValue];
                        switchOnSecondSelection = [options[@"switchOnSecondSelection"] boolValue];
                        selectionReads = 0;
                        trusted = ![options[@"denyAccessibility"] boolValue];
                        readOnly = [options[@"readOnly"] boolValue];
                        modifiers = [options[@"held"] boolValue];
                        dropWrite = [options[@"dropWrite"] boolValue];
                        NSMutableDictionary *state = [@{
                            @"text": documents[0], @"other": documents[1], @"writes": @(writes),
                            @"focused": @(focused),
                        } mutableCopy];
                        if (browser) state[@"chunks"] = browserChunks;
                        emitMessage(@{@"request": message[@"request"], @"fixture": state});
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
        if (argc == 2) {
            browser = strcmp(argv[1], "browser") == 0;
            runFixture();
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
