#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <stdio.h>

static NSString *const permissionError =
    @"Allow My Audio to Text in System Settings → Privacy & Security → Device Control and Data Access (Accessibility), then start again.";
static NSString *const keyboardError =
    @"Allow keyboard event posting for My Audio to Text under Device Control and Data Access (Accessibility), then restart the app.";
static NSString *const targetError =
    @"Focus an editable TextEdit document or a text field on a Chrome page. This field cannot be safely edited.";
static NSString *const focusError = @"The authorized window or text field changed or lost focus.";
static NSString *const writeError = @"TextEdit did not confirm the complete edit. Voice typing stopped.";
static NSString *const clipboardError = @"The clipboard changed or could not be preserved. Voice typing stopped.";
static NSString *const pasteUnconfirmed = @"Chrome paste was dispatched, but the edit could not be confirmed. Voice typing stopped.";

static id attribute(AXUIElementRef element, CFStringRef key) {
    CFTypeRef value = NULL;
    if (!element || AXUIElementCopyAttributeValue(element, key, &value) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(value);
}

static id elementAttribute(AXUIElementRef element, CFStringRef key) {
    id value = attribute(element, key);
    return value && CFGetTypeID((__bridge CFTypeRef)value) == AXUIElementGetTypeID() ? value : nil;
}

static BOOL writable(AXUIElementRef element, CFStringRef key) {
    Boolean allowed = false;
    return AXUIElementIsAttributeSettable(element, key, &allowed) == kAXErrorSuccess && allowed;
}

static BOOL readSelection(AXUIElementRef element, CFRange *range) {
    id selection = attribute(element, kAXSelectedTextRangeAttribute);
    return selection && CFGetTypeID((__bridge CFTypeRef)selection) == AXValueGetTypeID() &&
        AXValueGetValue((__bridge AXValueRef)selection, kAXValueTypeCFRange, range);
}

static BOOL isDocumentArea(AXUIElementRef area, AXUIElementRef window) {
    if (!area || !window ||
        ![attribute(area, kAXRoleAttribute) isEqual:@"AXTextArea"] ||
        [attribute(area, kAXSubroleAttribute) isEqual:@"AXSecureTextField"] ||
        ![attribute(area, kAXFocusedAttribute) isEqual:@YES] ||
        ![attribute(window, kAXSubroleAttribute) isEqual:@"AXStandardWindow"] ||
        !writable(area, kAXSelectedTextAttribute)) return NO;

    id parent = elementAttribute(area, kAXParentAttribute);
    if (!parent ||
        ![attribute((__bridge AXUIElementRef)parent, kAXRoleAttribute) isEqual:@"AXScrollArea"]) return NO;
    id owner = elementAttribute(area, kAXWindowAttribute);
    return owner && CFEqual((__bridge CFTypeRef)owner, window);
}

static BOOL isBrowserField(AXUIElementRef area, AXUIElementRef window) {
    if (!area || !window || ![attribute(window, kAXSubroleAttribute) isEqual:@"AXStandardWindow"]) return NO;
    id role = attribute(area, kAXRoleAttribute);
    if (![role isEqual:@"AXTextField"] && ![role isEqual:@"AXTextArea"]) return NO;
    CFTypeRef subrole = NULL;
    AXError status = AXUIElementCopyAttributeValue(area, kAXSubroleAttribute, &subrole);
    id fieldSubrole = CFBridgingRelease(subrole);
    if ((status != kAXErrorSuccess && status != kAXErrorNoValue && status != kAXErrorAttributeUnsupported) ||
        [fieldSubrole isEqual:@"AXSecureTextField"] ||
        ![attribute(area, kAXEnabledAttribute) isEqual:@YES] ||
        ![attribute(area, kAXFocusedAttribute) isEqual:@YES] ||
        // Chrome exposes writable AXValue for editable fields. Use it only as
        // evidence of editability. Paste does not require writable AXSelectedText.
        !writable(area, kAXValueAttribute)) return NO;
    id owner = elementAttribute(area, kAXWindowAttribute);
    if (!owner || !CFEqual((__bridge CFTypeRef)owner, window)) return NO;

    // Require a web document ancestor. Browser chrome, including the address
    // bar and native dialogs, is outside this adapter.
    id ancestor = elementAttribute(area, kAXParentAttribute);
    for (NSUInteger depth = 0; ancestor && depth < 32; depth++) {
        AXUIElementRef element = (__bridge AXUIElementRef)ancestor;
        id parentRole = attribute(element, kAXRoleAttribute);
        if ([parentRole isEqual:@"AXWebArea"]) return YES;
        if (!parentRole || [parentRole isEqual:@"AXWindow"]) return NO;
        ancestor = elementAttribute(element, kAXParentAttribute);
    }
    return NO;
}

@interface Binding : NSObject
@property pid_t pid;
@property BOOL browser;
// ARC retains the CF-backed accessibility elements as Objective-C objects.
@property (strong) id application;
@property (strong) id window;
@property (strong) id area;
@property (strong) NSString *failed;
@property AXObserverRef observer;
@end

@interface BrowserPaste : NSObject
@property (strong) NSPasteboard *board;
@property (strong) NSArray<NSPasteboardItem *> *saved;
@property NSInteger generation;
@property CFAbsoluteTime deadline;
@property (strong) NSString *canceled;
@end

@implementation BrowserPaste
@end

@implementation Binding
- (void)dealloc {
    if (_observer) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_observer), kCFRunLoopCommonModes);
        CFRelease(_observer);
    }
}
@end

static Binding *candidate;
static Binding *trayCandidate;
static Binding *bound;
static NSString *token;
static NSNumber *snapshotNumber;
static NSNumber *nextSnapshot;
static EventHotKeyRef hotkey;
static UInt32 hotkeyID;
static NSString *shortcut;
static BOOL held;
static BOOL shortcutSessionActive;
static NSNumber *shortcutContext;
static NSNumber *heldContext;
static BOOL waitingForRelease;
static NSString *pendingText;
static NSNumber *pendingRequest;
static CFAbsoluteTime writeAfter;
static CFAbsoluteTime nextWaitingNotice;
static BrowserPaste *browserPaste;

static void emitMessage(NSDictionary *message) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:NULL];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void respond(NSNumber *request, NSString *error) {
    if (error) emitMessage(@{@"request": request, @"error": error});
    else emitMessage(@{@"request": request});
}

static void finishWrite(NSString *error) {
    NSNumber *request = pendingRequest;
    pendingRequest = nil;
    pendingText = nil;
    waitingForRelease = NO;
    if (request) respond(request, error);
}

static NSString *restoreClipboard(BrowserPaste *paste) {
    if (paste.board.changeCount != paste.generation) return clipboardError;
    [paste.board clearContents];
    return paste.saved.count && ![paste.board writeObjects:paste.saved] ? clipboardError : nil;
}

static void finishBrowserPaste(NSString *error) {
    NSString *restoreError = restoreClipboard(browserPaste);
    browserPaste = nil;
    finishWrite(error ?: restoreError);
}

static void cancelWrite(NSString *error) {
    if (browserPaste) {
        // An enqueued key event may still read the board. Keep the same
        // bounded settle time even when the session loses authorization.
        if (!browserPaste.canceled) browserPaste.canceled = error;
    } else {
        finishWrite(error);
    }
}

static void invalidate(Binding *binding, NSString *error) {
    if (!binding || binding.failed) return;
    binding.failed = error;
    if (binding == bound) {
        cancelWrite(error);
        emitMessage(@{@"invalid": token, @"error": error});
    }
}

static void focusedChanged(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void *context) {
    (void)observer;
    (void)element;
    (void)notification;
    // Copy the strong reference before any invalidation can release it.
    Binding *binding = (__bridge Binding *)context;
    invalidate(binding, focusError);
}

static BOOL supportedField(Binding *binding) {
    AXUIElementRef area = (__bridge AXUIElementRef)binding.area;
    AXUIElementRef window = (__bridge AXUIElementRef)binding.window;
    return binding.browser ? isBrowserField(area, window) : isDocumentArea(area, window);
}

static Binding *captureTarget(void) {
    Binding *result = [Binding new];
    if (!AXIsProcessTrusted()) {
        result.failed = permissionError;
        return result;
    }
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    result.browser = [front.bundleIdentifier isEqualToString:@"com.google.Chrome"];
    BOOL textEdit = [front.bundleIdentifier isEqualToString:@"com.apple.TextEdit"] &&
        [front.bundleURL.path isEqualToString:@"/System/Applications/TextEdit.app"];
    if (!result.browser && !textEdit) {
        result.failed = targetError;
        return result;
    }

    pid_t pid = front.processIdentifier;
    result.pid = pid;
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    result.application = CFBridgingRelease(application);
    AXUIElementSetMessagingTimeout(application, 0.25);
    // Reading the application role is Chrome's assistive-client discovery path.
    if (result.browser) (void)attribute(application, kAXRoleAttribute);
    result.window = elementAttribute(application, kAXFocusedWindowAttribute);
    result.area = elementAttribute(application, kAXFocusedUIElementAttribute);
    if (!supportedField(result)) {
        // Chrome may need time to expose its web accessibility tree on the
        // first request. Let Chrome initialize it, but require a fresh Start
        // to bind an identifiable field.
        id role = attribute((__bridge AXUIElementRef)result.area, kAXRoleAttribute);
        if (result.browser && (!result.area || [role isEqual:@"AXWebArea"])) {
            AXUIElementSetAttributeValue(application, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
        }
        result.failed = targetError;
        return result;
    }

    AXObserverRef observer = NULL;
    if (AXObserverCreate(pid, focusedChanged, &observer) != kAXErrorSuccess) {
        result.failed = targetError;
        return result;
    }
    result.observer = observer;
    if (AXObserverAddNotification(observer, application, kAXFocusedUIElementChangedNotification,
                                  (__bridge void *)result) != kAXErrorSuccess ||
        AXObserverAddNotification(observer, application, kAXFocusedWindowChangedNotification,
                                  (__bridge void *)result) != kAXErrorSuccess ||
        AXObserverAddNotification(observer, (__bridge AXUIElementRef)result.window, kAXUIElementDestroyedNotification,
                                  (__bridge void *)result) != kAXErrorSuccess) {
        result.failed = targetError;
        return result;
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopCommonModes);
    return result;
}

static BOOL hasBoundFocus(Binding *binding) {
    AXUIElementRef application = (__bridge AXUIElementRef)binding.application;
    NSArray *keys = @[(__bridge NSString *)kAXFocusedWindowAttribute, (__bridge NSString *)kAXFocusedUIElementAttribute];
    CFArrayRef values = NULL;
    if (AXUIElementCopyMultipleAttributeValues(application, (__bridge CFArrayRef)keys,
            kAXCopyMultipleAttributeOptionStopOnError, &values) != kAXErrorSuccess) return NO;
    NSArray *focus = CFBridgingRelease(values);
    return focus.count == 2 &&
        CFEqual((__bridge CFTypeRef)focus[0], (__bridge CFTypeRef)binding.window) &&
        CFEqual((__bridge CFTypeRef)focus[1], (__bridge CFTypeRef)binding.area) &&
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == binding.pid;
}

static NSString *check(Binding *binding) {
    if (binding.failed) return binding.failed;
    if (!AXIsProcessTrusted()) return permissionError;
    if (binding.browser && !CGPreflightPostEventAccess()) return keyboardError;
    if (!hasBoundFocus(binding)) return focusError;
    return supportedField(binding) ? nil : targetError;
}

static void verifyWrite(NSNumber *request, NSString *expected, CFIndex caret, CFAbsoluteTime deadline) {
    if (![request isEqual:pendingRequest]) return;
    NSString *error = check(bound);
    if (error) {
        finishWrite(error);
        return;
    }
    AXUIElementRef area = (__bridge AXUIElementRef)bound.area;
    CFRange selection;
    if ([attribute(area, kAXValueAttribute) isEqual:expected] && readSelection(area, &selection) &&
        selection.location == caret && selection.length == 0) {
        finishWrite(nil);
    } else if (CFAbsoluteTimeGetCurrent() >= deadline) {
        finishWrite(writeError);
    } else {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            verifyWrite(request, expected, caret, deadline);
        });
    }
}

static BOOL shortcutHeld(void) {
    return held || (GetCurrentKeyModifiers() & (cmdKey | shiftKey | optionKey | controlKey));
}

static NSArray<NSPasteboardItem *> *copyClipboard(NSPasteboard *board) {
    if (@available(macOS 15.4, *)) {
        if (board.accessBehavior == NSPasteboardAccessBehaviorAlwaysDeny) return nil;
    }
    NSArray<NSPasteboardItem *> *items = board.pasteboardItems;
    if (!items && board.types.count) return nil;
    NSMutableArray<NSPasteboardItem *> *saved = [NSMutableArray array];
    for (NSPasteboardItem *item in items) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (!data || ![copy setData:data forType:type]) return nil;
        }
        if (!copy.types.count) return nil;
        [saved addObject:copy];
    }
    return saved;
}

static void verifyBrowserPaste(NSNumber *request, NSString *value, CFRange selection) {
    if (![request isEqual:pendingRequest]) return;
    if (browserPaste.board.changeCount != browserPaste.generation) {
        finishBrowserPaste(browserPaste.canceled ?: clipboardError);
        return;
    }
    NSString *error = browserPaste.canceled ?: check(bound);
    if (error) browserPaste.canceled = error;
    if (!error) {
        AXUIElementRef area = (__bridge AXUIElementRef)bound.area;
        NSString *current = attribute(area, kAXValueAttribute);
        CFRange caret;
        // Native paste is allowed to produce a partial or transformed edit.
        // Read-back is evidence of consumption, never a reason to repair it.
        if ([current isKindOfClass:NSString.class] && readSelection(area, &caret) &&
            (![current isEqual:value] || caret.location != selection.location || caret.length != selection.length)) {
            finishBrowserPaste(nil);
            return;
        }
    }
    if (CFAbsoluteTimeGetCurrent() >= browserPaste.deadline) {
        finishBrowserPaste(error ?: pasteUnconfirmed);
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        verifyBrowserPaste(request, value, selection);
    });
}

static void pasteInBrowser(void) {
    Binding *binding = bound;
    NSNumber *request = pendingRequest;
    NSString *text = pendingText;
    AXUIElementRef area = (__bridge AXUIElementRef)binding.area;
    NSString *value = attribute(area, kAXValueAttribute);
    CFRange selection;
    if (![value isKindOfClass:NSString.class] || !readSelection(area, &selection)) {
        finishWrite(targetError);
        return;
    }

    CGEventRef down = CGEventCreateKeyboardEvent(NULL, kVK_ANSI_V, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, kVK_ANSI_V, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        finishWrite(@"The native Chrome paste command could not be created.");
        return;
    }
    id keepDown = CFBridgingRelease(down);
    id keepUp = CFBridgingRelease(up);
    CGEventSetFlags((__bridge CGEventRef)keepDown, kCGEventFlagMaskCommand);
    CGEventSetFlags((__bridge CGEventRef)keepUp, kCGEventFlagMaskCommand);

    BrowserPaste *paste = [BrowserPaste new];
    paste.board = NSPasteboard.generalPasteboard;
    NSInteger generation = paste.board.changeCount;
    paste.saved = copyClipboard(paste.board);
    if (![request isEqual:pendingRequest]) return;
    NSPasteboardItem *item = [NSPasteboardItem new];
    if (!paste.saved || ![item setString:text forType:NSPasteboardTypeString] ||
        ![item setData:NSData.data forType:@"org.nspasteboard.TransientType"]) {
        finishWrite(clipboardError);
        return;
    }
    NSString *error = check(binding);
    if (error || paste.board.changeCount != generation) {
        finishWrite(error ?: clipboardError);
        return;
    }
    if (shortcutHeld()) return;
    paste.generation = [paste.board clearContents];
    if (![paste.board writeObjects:@[item]]) {
        finishWrite(restoreClipboard(paste) ?: clipboardError);
        return;
    }
    // writeObjects appends to the generation opened by clearContents.
    // A different generation belongs to another writer.
    CFRange currentSelection;
    if (![attribute(area, kAXValueAttribute) isEqual:value] ||
        !readSelection(area, &currentSelection) || currentSelection.location != selection.location ||
        currentSelection.length != selection.length) {
        error = @"The browser text or selection changed before paste. Voice typing stopped.";
    }
    if (!error) error = check(binding);
    if (!error && !hasBoundFocus(binding)) error = focusError;
    if (![request isEqual:pendingRequest]) {
        restoreClipboard(paste);
        return;
    }
    if (error || paste.board.changeCount != paste.generation || shortcutHeld()) {
        NSString *restoreError = restoreClipboard(paste);
        if (error || restoreError) finishWrite(error ?: restoreError);
        return;
    }
    waitingForRelease = NO;
    browserPaste = paste;
    // Only Chrome can receive this key pair. The final AX focus read above
    // also covers a change to a different field in the same process.
    CGEventPostToPid(binding.pid, (__bridge CGEventRef)keepDown);
    CGEventPostToPid(binding.pid, (__bridge CGEventRef)keepUp);
    paste.deadline = CFAbsoluteTimeGetCurrent() + 0.6;
    verifyBrowserPaste(request, value, selection);
}

static void insertWhenReleased(void) {
    if (!waitingForRelease) return;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (shortcutHeld()) {
        writeAfter = now + 0.08;
        if (now >= nextWaitingNotice) {
            emitMessage(@{@"request": pendingRequest, @"waiting": @YES});
            nextWaitingNotice = now + 1;
        }
        return;
    }
    if (now < writeAfter) return;
    NSString *error = check(bound);
    if (error) {
        finishWrite(error);
        return;
    }
    if (bound.browser) {
        pasteInBrowser();
        return;
    }
    AXUIElementRef area = (__bridge AXUIElementRef)bound.area;
    NSString *value = attribute(area, kAXValueAttribute);
    CFRange range;
    if (![value isKindOfClass:NSString.class] || !readSelection(area, &range) ||
        range.location < 0 || range.length < 0 || (NSUInteger)range.location > value.length ||
        (NSUInteger)range.length > value.length - (NSUInteger)range.location) {
        finishWrite(targetError);
        return;
    }
    NSRange selected = NSMakeRange((NSUInteger)range.location, (NSUInteger)range.length);
    NSString *expected = [value stringByReplacingCharactersInRange:selected withString:pendingText];
    error = check(bound);
    CFRange currentSelection;
    if (error || ![attribute(area, kAXValueAttribute) isEqual:value] || !readSelection(area, &currentSelection) ||
        currentSelection.location != range.location || currentSelection.length != range.length) {
        finishWrite(error ?: @"The document changed before the edit. Voice typing stopped.");
        return;
    }
    // Value and selection reads can outlast a same-process focus change whose
    // observer callback has yet to run. Read window and field together last.
    if (!hasBoundFocus(bound)) {
        finishWrite(focusError);
        return;
    }
    // Check modifiers again after the final cross-process read.
    if (shortcutHeld()) {
        writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
        return;
    }
    waitingForRelease = NO;
    CFIndex caret = range.location + (CFIndex)pendingText.length;
    // The write addresses the original element. No clipboard or keyboard event can reach a different field.
    if (AXUIElementSetAttributeValue(area, kAXSelectedTextAttribute, (__bridge CFStringRef)pendingText) != kAXErrorSuccess) {
        finishWrite(writeError);
        return;
    }
    verifyWrite(pendingRequest, expected, caret, CFAbsoluteTimeGetCurrent() + 0.6);
}

static NSDictionary<NSString *, NSNumber *> *keys(void) {
    return @{
        @"A": @(kVK_ANSI_A), @"B": @(kVK_ANSI_B), @"C": @(kVK_ANSI_C), @"D": @(kVK_ANSI_D), @"E": @(kVK_ANSI_E),
        @"F": @(kVK_ANSI_F), @"G": @(kVK_ANSI_G), @"H": @(kVK_ANSI_H), @"I": @(kVK_ANSI_I), @"J": @(kVK_ANSI_J),
        @"K": @(kVK_ANSI_K), @"L": @(kVK_ANSI_L), @"M": @(kVK_ANSI_M), @"N": @(kVK_ANSI_N), @"O": @(kVK_ANSI_O),
        @"P": @(kVK_ANSI_P), @"Q": @(kVK_ANSI_Q), @"R": @(kVK_ANSI_R), @"S": @(kVK_ANSI_S), @"T": @(kVK_ANSI_T),
        @"U": @(kVK_ANSI_U), @"V": @(kVK_ANSI_V), @"W": @(kVK_ANSI_W), @"X": @(kVK_ANSI_X), @"Y": @(kVK_ANSI_Y),
        @"Z": @(kVK_ANSI_Z), @"0": @(kVK_ANSI_0), @"1": @(kVK_ANSI_1), @"2": @(kVK_ANSI_2), @"3": @(kVK_ANSI_3),
        @"4": @(kVK_ANSI_4), @"5": @(kVK_ANSI_5), @"6": @(kVK_ANSI_6), @"7": @(kVK_ANSI_7), @"8": @(kVK_ANSI_8),
        @"9": @(kVK_ANSI_9), @"F1": @(kVK_F1), @"F2": @(kVK_F2), @"F3": @(kVK_F3), @"F4": @(kVK_F4), @"F5": @(kVK_F5),
        @"F6": @(kVK_F6), @"F7": @(kVK_F7), @"F8": @(kVK_F8), @"F9": @(kVK_F9), @"F10": @(kVK_F10), @"F11": @(kVK_F11),
        @"F12": @(kVK_F12),
    };
}

static NSString *setShortcut(NSString *value) {
    if ([value isEqual:shortcut]) return nil;
    NSArray<NSString *> *parts = [value componentsSeparatedByString:@"+"];
    NSNumber *key = keys()[parts.lastObject];
    NSDictionary *modifiers = @{@"Control": @(controlKey), @"Alt": @(optionKey), @"Shift": @(shiftKey), @"Super": @(cmdKey)};
    UInt32 mask = 0;
    for (NSUInteger i = 0; i + 1 < parts.count; i++) mask |= [modifiers[parts[i]] unsignedIntValue];

    EventHotKeyRef replacement = NULL;
    if (value.length && (!key || !mask ||
        RegisterEventHotKey(key.unsignedIntValue, mask, (EventHotKeyID){'matt', hotkeyID + 1},
                            GetApplicationEventTarget(), kEventHotKeyExclusive, &replacement) != noErr)) {
        return @"The shortcut is unavailable. Choose a different combination in Settings.";
    }
    if (hotkey) UnregisterEventHotKey(hotkey);
    hotkey = replacement;
    hotkeyID++;
    shortcut = value;
    held = NO;
    heldContext = nil;
    candidate = nil;
    return nil;
}

static void snapshot(void) {
    candidate = captureTarget();
    nextSnapshot = @([nextSnapshot unsignedLongLongValue] + 1);
    snapshotNumber = nextSnapshot;
}

static OSStatus shortcutEvent(EventHandlerCallRef call, EventRef event, void *context) {
    (void)call;
    (void)context;
    EventHotKeyID eventID;
    if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL,
                          sizeof(eventID), NULL, &eventID) != noErr || eventID.id != hotkeyID) {
        return eventNotHandledErr;
    }
    if (GetEventKind(event) == kEventHotKeyPressed) {
        if (!held) {
            held = YES;
            heldContext = shortcutContext;
            if (!shortcutSessionActive && !bound) snapshot();
        }
    } else if (held) {
        held = NO;
        writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
        // The host owns session identity, including Live graphs without an AX binding.
        emitMessage(@{@"shortcut": shortcut, @"release": snapshotNumber ?: @0, @"context": heldContext ?: @0});
        heldContext = nil;
    }
    return noErr;
}

static void handle(NSDictionary *message) {
    NSString *action = message[@"action"];
    NSString *id = message[@"token"];
    NSNumber *request = message[@"request"];
    if ([action isEqualToString:@"set-shortcut"]) {
        respond(request, setShortcut(message[@"text"]));
    } else if ([action isEqualToString:@"shortcut-context"]) {
        shortcutContext = message[@"text"];
        shortcutSessionActive = [id isKindOfClass:NSString.class];
        respond(request, nil);
    } else if ([action isEqualToString:@"snapshot-tray"]) {
        trayCandidate = !bound && !held ? captureTarget() : nil;
        respond(request, nil);
    } else if ([action isEqualToString:@"bind-shortcut"] || [action isEqualToString:@"bind-tray"]) {
        BOOL fromShortcut = [action isEqualToString:@"bind-shortcut"];
        Binding *start = fromShortcut ? candidate : trayCandidate;
        if (fromShortcut) candidate = nil;
        else trayCandidate = nil;
        if (bound || !start || (fromShortcut && ![message[@"text"] isEqual:snapshotNumber])) {
            respond(request, focusError);
            return;
        }
        if (!AXIsProcessTrusted()) {
            AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES});
            respond(request, permissionError);
            return;
        }
        NSString *error = check(start);
        if (!error) {
            bound = start;
            token = id;
        } else if (error == keyboardError) {
            CGRequestPostEventAccess();
        }
        respond(request, error);
    } else if ([action isEqualToString:@"release"]) {
        if ([id isEqual:token]) {
            bound = nil;
            token = nil;
            cancelWrite(focusError);
        }
        respond(request, nil);
    } else if ([action isEqualToString:@"insert"] && [id isEqual:token] && !pendingRequest) {
        pendingRequest = request;
        pendingText = message[@"text"];
        waitingForRelease = YES;
        insertWhenReleased();
    } else {
        respond(request, focusError);
    }
}

int main(void) {
    @autoreleasepool {
        [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyProhibited];
        const EventTypeSpec events[] = {
            { kEventClassKeyboard, kEventHotKeyPressed }, { kEventClassKeyboard, kEventHotKeyReleased },
        };
        if (InstallApplicationEventHandler(shortcutEvent, 2, events, NULL, NULL) != noErr) return 1;
        [NSWorkspace.sharedWorkspace.notificationCenter
            addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue
            usingBlock:^(NSNotification *note) {
                pid_t pid = [note.userInfo[NSWorkspaceApplicationKey] processIdentifier];
                if (candidate && pid != candidate.pid) invalidate(candidate, focusError);
                if (trayCandidate && pid != trayCandidate.pid) invalidate(trayCandidate, focusError);
                if (bound && pid != bound.pid) invalidate(bound, focusError);
            }];

        dispatch_source_t poll = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(poll, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), 50 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(poll, ^{
            if (bound && !bound.failed && !AXIsProcessTrusted()) invalidate(bound, permissionError);
            insertWhenReleased();
        });
        dispatch_resume(poll);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char *line = NULL;
            size_t capacity = 0;
            ssize_t length;
            while ((length = getline(&line, &capacity, stdin)) >= 0) {
                @autoreleasepool {
                    NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
                    NSDictionary *message = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                    if ([message isKindOfClass:NSDictionary.class]) {
                        dispatch_sync(dispatch_get_main_queue(), ^{ handle(message); });
                    }
                }
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{ exit(0); });
        });
        [NSApplication.sharedApplication run];
    }
    return 0;
}
