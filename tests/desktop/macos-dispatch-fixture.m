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
+ (instancetype)sharedWorkspace;
@end

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSRunningApplication *)frontmostApplication { return (NSRunningApplication *)self; }
- (NSNotificationCenter *)notificationCenter { return NSNotificationCenter.defaultCenter; }
- (pid_t)processIdentifier { return 100; }
@end

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
    else if ([key isEqual:@"AXRole"]) result = object == fields[0] ? @"AXTextArea" : @"AXScrollArea";
    else if ([key isEqual:@"AXSubrole"] && object == windows[0]) result = @"AXStandardWindow";
    else if ([key isEqual:@"AXFocused"]) result = @(object == fields[focused]);
    else if ([key isEqual:@"AXParent"]) result = windows[0];
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

static AXError selectedTextWritable(AXUIElementRef element, CFStringRef key, Boolean *allowed) {
    *allowed = (__bridge id)element == fields[0] && CFEqual(key, kAXSelectedTextAttribute);
    return kAXErrorSuccess;
}

static AXError editDocument(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
    assert(CFEqual(key, kAXSelectedTextAttribute));
    NSUInteger document = (__bridge id)element == fields[1];
    NSString *text = (__bridge NSString *)value;
    documents[document] = [documents[document] stringByReplacingCharactersInRange:
        NSMakeRange((NSUInteger)selection.location, (NSUInteger)selection.length) withString:text];
    selection = CFRangeMake(selection.location + (CFIndex)text.length, 0);
    return kAXErrorSuccess;
}

#define main packagedHelperMain
#define NSWorkspace FixtureWorkspace
#define AXIsProcessTrusted() YES
#define GetCurrentKeyModifiers() 0
#define AXUIElementCopyAttributeValue copyAttribute
#define AXUIElementCopyMultipleAttributeValues copyFocus
#define AXUIElementIsAttributeSettable selectedTextWritable
#define AXUIElementSetAttributeValue editDocument
#include "../../desktop/mac-target.m"
#undef main

int main(void) {
    @autoreleasepool {
        // Real CF-backed AX references provide distinct identities. The
        // substituted functions above make no requests to these PIDs.
        windows[0] = CFBridgingRelease(AXUIElementCreateApplication(101));
        windows[1] = CFBridgingRelease(AXUIElementCreateApplication(102));
        fields[0] = CFBridgingRelease(AXUIElementCreateApplication(103));
        fields[1] = CFBridgingRelease(AXUIElementCreateApplication(104));
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
