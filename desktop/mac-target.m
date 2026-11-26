#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <signal.h>
#import <stdio.h>

static NSString *const permissionError =
    @"Allow My Audio to Text in System Settings → Privacy & Security → Device Control and Data Access (Accessibility), then start again.";
static NSString *const targetError = @"Focus the app where you want to type and start again.";
static NSString *const focusError = @"The authorized window or text field changed or lost focus.";
static NSString *const protectedFieldError = @"The focused field is protected. Focus a different field and start again.";
static NSString *const disabledFieldError = @"The focused field is disabled. Focus an editable field and start again.";
static NSString *const readOnlyFieldError = @"The focused field is read-only. Focus an editable field and start again.";
static NSString *const secureInputError = @"macOS Secure Keyboard Entry is active. Focus a field that accepts ordinary input and start again.";
static NSString *const keyboardPermissionError =
    @"Allow My Audio to Text to post keyboard events under Device Control and Data Access (Accessibility) in System Settings → Privacy & Security, then start again.";
static NSString *const keyboardError = @"Could not send the Paste shortcut. Voice typing stopped.";
static NSString *const snapshotError = @"Could not read the existing clipboard for restoration. Voice typing stopped.";
static NSString *const clipboardError = @"Could not stage text on the clipboard. Voice typing stopped.";
static NSString *const clipboardChangedError = @"The clipboard changed before Paste. Voice typing stopped.";
static NSString *const restoreError = @"Could not restore the clipboard. Voice typing stopped.";
static const int64_t pasteSettleTime = 250 * NSEC_PER_MSEC;

static id attribute(AXUIElementRef element, CFStringRef key) {
    CFTypeRef value = NULL;
    if (!element || AXUIElementCopyAttributeValue(element, key, &value) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(value);
}

static id asElement(id value) {
    return value && CFGetTypeID((__bridge CFTypeRef)value) == AXUIElementGetTypeID() ? value : nil;
}

static id elementAttribute(AXUIElementRef element, CFStringRef key) {
    return asElement(attribute(element, key));
}

static NSString *fieldError(AXUIElementRef field) {
    if ([attribute(field, kAXFocusedAttribute) isEqual:@NO]) return focusError;
    id role = attribute(field, kAXRoleAttribute);
    id subrole = attribute(field, kAXSubroleAttribute);
    if ([role isEqual:(__bridge NSString *)kAXSecureTextFieldSubrole] ||
        [subrole isEqual:(__bridge NSString *)kAXSecureTextFieldSubrole]) return protectedFieldError;
    if ([attribute(field, kAXEnabledAttribute) isEqual:@NO]) return disabledFieldError;
    if ([attribute(field, CFSTR("AXReadOnly")) isEqual:@YES] ||
        [attribute(field, CFSTR("AXEditable")) isEqual:@NO]) return readOnlyFieldError;
    return nil;
}

@interface Binding : NSObject
@property pid_t pid;
// ARC retains the CF-backed accessibility elements as Objective-C objects.
@property (strong) id application;
@property (strong) id window;
@property (strong) id area;
@property (strong) NSString *failed;
@property AXObserverRef observer;
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
static BOOL pasteInFlight;
static CFAbsoluteTime writeAfter;
static CFAbsoluteTime nextWaitingNotice;
// The stdin reader publishes revocations while the main queue is in AX calls.
// Synchronize only this state so the reader never has to wait for an AX call.
static NSMutableSet<NSString *> *releaseRequests;
static BOOL inputClosed;

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
    // Cancellation revokes dispatch immediately. Keep the clipboard available
    // to an already posted Paste, and keep the queue blocked through cleanup.
    if (pasteInFlight) return;
    NSNumber *request = pendingRequest;
    pendingRequest = nil;
    pendingText = nil;
    waitingForRelease = NO;
    if (request) respond(request, error);
}

static void invalidate(Binding *binding, NSString *error) {
    if (!binding || binding.failed) return;
    binding.failed = error;
    if (binding == bound) {
        finishWrite(error);
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

static BOOL hasBoundFocus(Binding *binding) {
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    if (workspace.frontmostApplication.processIdentifier != binding.pid) return NO;

    AXUIElementRef application = (__bridge AXUIElementRef)binding.application;
    NSArray *keys = @[(__bridge NSString *)kAXFocusedWindowAttribute, (__bridge NSString *)kAXFocusedUIElementAttribute];
    CFArrayRef values = NULL;
    id window = nil, area = nil;
    // A provider can return one focus attribute and an error for the other.
    if (AXUIElementCopyMultipleAttributeValues(application, (__bridge CFArrayRef)keys, 0, &values) == kAXErrorSuccess) {
        NSArray *focus = CFBridgingRelease(values);
        if (focus.count == keys.count) {
            window = asElement(focus[0]);
            area = asElement(focus[1]);
        }
    } else {
        window = elementAttribute(application, kAXFocusedWindowAttribute);
        area = elementAttribute(application, kAXFocusedUIElementAttribute);
    }
    if (!area) {
        AXUIElementRef system = AXUIElementCreateSystemWide();
        id focused = elementAttribute(system, kAXFocusedUIElementAttribute);
        CFRelease(system);
        pid_t pid = 0;
        if (focused && AXUIElementGetPid((__bridge AXUIElementRef)focused, &pid) == kAXErrorSuccess) {
            if (pid != binding.pid) return NO;
            area = focused;
        }
    }
    id owner = elementAttribute((__bridge AXUIElementRef)area, kAXWindowAttribute);
    if (window && owner && ![window isEqual:owner]) return NO;
    window = window ?: owner;

    // An initially unknown identity may become observable. Once bound to an
    // identity, require it to still match before sending more text.
    if ((binding.window && ![binding.window isEqual:window]) || (binding.area && ![binding.area isEqual:area]) ||
        workspace.frontmostApplication.processIdentifier != binding.pid) return NO;
    if (!binding.window) binding.window = window;
    if (!binding.area) binding.area = area;
    return YES;
}

static Binding *captureTarget(void) {
    Binding *result = [Binding new];
    if (!AXIsProcessTrusted()) {
        result.failed = permissionError;
        return result;
    }
    pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    if (pid <= 0) {
        result.failed = targetError;
        return result;
    }
    result.pid = pid;
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    result.application = CFBridgingRelease(application);
    AXUIElementSetMessagingTimeout(application, 0.25);
    if (!hasBoundFocus(result)) {
        result.failed = focusError;
        return result;
    }

    // Notification support varies. Keep every observer the provider supports
    // and recheck the focused window and element even when it supports none.
    AXObserverRef observer = NULL;
    if (AXObserverCreate(pid, focusedChanged, &observer) == kAXErrorSuccess) {
        result.observer = observer;
        AXObserverAddNotification(observer, application, kAXFocusedUIElementChangedNotification, (__bridge void *)result);
        AXObserverAddNotification(observer, application, kAXFocusedWindowChangedNotification, (__bridge void *)result);
        if (result.window) {
            AXObserverAddNotification(observer, (__bridge AXUIElementRef)result.window, kAXUIElementDestroyedNotification,
                                      (__bridge void *)result);
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopCommonModes);
    }
    return result;
}

static NSString *checkTarget(Binding *binding) {
    if (binding.failed) return binding.failed;
    if (!AXIsProcessTrusted()) return permissionError;
    if (!hasBoundFocus(binding)) return focusError;
    if (IsSecureEventInputEnabled()) return secureInputError;
    return fieldError((__bridge AXUIElementRef)binding.area);
}

static NSString *check(Binding *binding) {
    NSString *error = checkTarget(binding);
    if (error) return error;
    return CGPreflightPostEventAccess() ? nil : keyboardPermissionError;
}

static BOOL shortcutHeld(void) {
    return held || (GetCurrentKeyModifiers() & (cmdKey | shiftKey | optionKey | controlKey));
}

static void notifyWriteWaiting(CFAbsoluteTime now) {
    if (now < nextWaitingNotice) return;
    emitMessage(@{@"request": pendingRequest, @"waiting": @YES});
    nextWaitingNotice = now + 1;
}

static BOOL releaseRequested(void) {
    @synchronized (releaseRequests) {
        return inputClosed || (token && [releaseRequests containsObject:token]);
    }
}

static NSString *checkDispatchFocus(Binding *binding) {
    id checkedArea = binding.area;
    // Focus can move within the same application during the preceding AX lookups.
    if (!hasBoundFocus(binding)) return focusError;
    if (!checkedArea && binding.area) {
        NSString *error = fieldError((__bridge AXUIElementRef)binding.area);
        if (error) return error;
        if (!hasBoundFocus(binding)) return focusError;
    }
    if (!AXIsProcessTrusted()) return permissionError;
    if (IsSecureEventInputEnabled()) return secureInputError;
    if (releaseRequested() || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != binding.pid) return focusError;
    return binding.failed;
}

static BOOL pasteKey(CGKeyCode *key) {
    // Resolve V under Command in the active layout. The ANSI V position can
    // invoke a different shortcut on layouts such as Dvorak.
    __attribute__((objc_precise_lifetime)) id source = CFBridgingRelease(TISCopyCurrentKeyboardLayoutInputSource());
    CFDataRef data = source ? TISGetInputSourceProperty((__bridge TISInputSourceRef)source, kTISPropertyUnicodeKeyLayoutData) : NULL;
    if (!data) {
        source = CFBridgingRelease(TISCopyCurrentASCIICapableKeyboardLayoutInputSource());
        if (source) data = TISGetInputSourceProperty((__bridge TISInputSourceRef)source, kTISPropertyUnicodeKeyLayoutData);
    }
    if (!data) return NO;
    const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(data);
    UInt32 keyboardType = LMGetKbdType();
    for (CGKeyCode code = 0; code < 128; code++) {
        UInt32 dead = 0;
        UniChar chars[4];
        UniCharCount length = 0;
        if (UCKeyTranslate(layout, code, kUCKeyActionDisplay, cmdKey >> 8, keyboardType,
                kUCKeyTranslateNoDeadKeysMask, &dead, 4, &length, chars) == noErr &&
            length == 1 && (chars[0] == 'v' || chars[0] == 'V')) {
            *key = code;
            return YES;
        }
    }
    return NO;
}

static NSArray<NSPasteboardItem *> *snapshotClipboard(NSPasteboard *board) {
    NSMutableArray *snapshot = [NSMutableArray array];
    NSArray<NSPasteboardItem *> *items = board.pasteboardItems;
    if (!items) return nil;
    for (NSPasteboardItem *item in items) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (data) [copy setData:data forType:type];
        }
        // Some formats are promised by their source and can't be materialized.
        if (copy.types.count) [snapshot addObject:copy];
    }
    return items.count && !snapshot.count ? nil : snapshot;
}

static NSString *restoreClipboard(NSPasteboard *board, NSInteger generation, NSArray<NSPasteboardItem *> *snapshot) {
    // AppKit doesn't expose a compare-and-swap. Check ownership immediately
    // before claiming the board, and let an intervening owner keep its data.
    if (board.changeCount != generation) return nil;
    // The snapshot contains item data, but AppKit doesn't expose the original
    // sharing options. Keep restored contents on this Mac.
    NSInteger restoration = [board prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    if (!snapshot.count) return nil;
    if ([board writeObjects:snapshot] || board.changeCount != restoration) return nil;
    return restoreError;
}

static void pasteText(Binding *binding) {
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    NSPasteboardItem *item = [NSPasteboardItem new];
    if (![item setString:pendingText forType:NSPasteboardTypeString]) {
        finishWrite(clipboardError);
        return;
    }
    // Clipboard managers that honor this convention can skip temporary text.
    [item setData:[NSData data] forType:@"org.nspasteboard.TransientType"];
    NSInteger original = board.changeCount;
    NSArray<NSPasteboardItem *> *snapshot = snapshotClipboard(board);
    if (releaseRequested()) {
        finishWrite(focusError);
        return;
    }
    if (!snapshot || board.changeCount != original) {
        finishWrite(snapshot ? clipboardChangedError : snapshotError);
        return;
    }

    NSInteger generation = [board prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    NSString *error = [board writeObjects:@[item]] ? nil : clipboardError;
    if (!error) error = check(binding) ?: checkDispatchFocus(binding);

    CGEventRef down = NULL, up = NULL;
    if (!error) {
        // Staging and Accessibility calls can outlast a keyboard layout change.
        CGKeyCode key;
        if (pasteKey(&key)) {
            down = CGEventCreateKeyboardEvent(NULL, key, true);
            up = CGEventCreateKeyboardEvent(NULL, key, false);
        }
        if (!down || !up) error = keyboardError;
    }
    if (!error && board.changeCount != generation) error = clipboardChangedError;

    BOOL posted = NO;
    @synchronized (releaseRequests) {
        // Linearize cancellation with posting the single key pair. The reader
        // can revoke while AX or clipboard calls are running outside this lock.
        if (!error && (inputClosed || [releaseRequests containsObject:token])) error = focusError;
        if (!error && !shortcutHeld()) {
            CGEventSetFlags(down, kCGEventFlagMaskCommand);
            CGEventSetFlags(up, kCGEventFlagMaskCommand);
            CGEventPostToPid(binding.pid, down);
            CGEventPostToPid(binding.pid, up);
            posted = YES;
        }
    }
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    if (!posted) {
        NSString *cleanupError = restoreClipboard(board, generation, snapshot);
        if (error || cleanupError) finishWrite(cleanupError ?: error);
        else writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
        return;
    }

    waitingForRelease = NO;
    pendingText = nil;
    pasteInFlight = YES;
    // The target may read asynchronously. A bounded wait gives it time without
    // interpreting a key event or pasteboard read as confirmation of an edit.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, pasteSettleTime), dispatch_get_main_queue(), ^{
        NSString *cleanupError = restoreClipboard(board, generation, snapshot);
        pasteInFlight = NO;
        finishWrite(cleanupError ?: binding.failed);
        @synchronized (releaseRequests) {
            if (inputClosed) exit(0);
        }
    });
}

static void insertWhenReleased(void) {
    if (!waitingForRelease) return;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (shortcutHeld()) {
        writeAfter = now + 0.08;
        notifyWriteWaiting(now);
        return;
    }
    if (now < writeAfter) return;
    Binding *binding = bound;
    NSString *error = check(binding);
    if (error) {
        finishWrite(error);
        return;
    }

    pasteText(binding);
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
        if (bound || pendingRequest || !start || (fromShortcut && ![message[@"text"] isEqual:snapshotNumber])) {
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
        }
        respond(request, error);
    } else if ([action isEqualToString:@"release"]) {
        if ([id isEqual:token]) {
            bound = nil;
            token = nil;
            finishWrite(focusError);
        }
        if ([id isKindOfClass:NSString.class]) {
            @synchronized (releaseRequests) {
                [releaseRequests removeObject:id];
            }
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

static void readRequests(void (^receive)(NSDictionary *)) {
    releaseRequests = [NSMutableSet set];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char *line = NULL;
        size_t capacity = 0;
        ssize_t length;
        while ((length = getline(&line, &capacity, stdin)) >= 0) {
            @autoreleasepool {
                NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
                NSDictionary *message = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                if (![message isKindOfClass:NSDictionary.class]) continue;
                NSString *id = message[@"token"];
                if ([message[@"action"] isEqual:@"release"] && [id isKindOfClass:NSString.class]) {
                    @synchronized (releaseRequests) {
                        [releaseRequests addObject:id];
                    }
                }
                receive(message);
            }
        }
        free(line);
        @synchronized (releaseRequests) {
            inputClosed = YES;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!pasteInFlight) exit(0);
        });
    });
}

int main(void) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
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
        readRequests(^(NSDictionary *message) {
            dispatch_async(dispatch_get_main_queue(), ^{ handle(message); });
        });
        [NSApplication.sharedApplication run];
    }
    return 0;
}
