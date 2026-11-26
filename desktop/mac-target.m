#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <stdio.h>

static NSString *const permissionError =
    @"Allow My Audio to Text in System Settings → Privacy & Security → Device Control and Data Access (Accessibility), then start again.";
static NSString *const targetError = @"Focus the app where you want to type and start again.";
static NSString *const focusError = @"The authorized window or text field changed or lost focus.";
static NSString *const protectedFieldError = @"The focused field is protected. Focus a different field and start again.";
static NSString *const disabledFieldError = @"The focused field is disabled. Focus an editable field and start again.";
static NSString *const readOnlyFieldError = @"The focused field is read-only. Focus an editable field and start again.";
static NSString *const secureInputError = @"macOS Secure Keyboard Entry is active. Focus a field that accepts ordinary input and start again.";
static NSString *const selectionError = @"The text or selection changed before the edit. Voice typing stopped.";
static NSString *const writeError = @"The focused field rejected the Accessibility edit. Voice typing stopped.";
static NSString *const keyboardPermissionError =
    @"Allow My Audio to Text to post keyboard events under Device Control and Data Access (Accessibility) in System Settings → Privacy & Security, then start again.";
static NSString *const keyboardError = @"Could not send text to the focused field. Voice typing stopped.";
static CFStringRef const replaceRange = CFSTR("AXReplaceRangeWithText");

typedef NS_ENUM(NSInteger, EditMethod) { SelectedText, RangeReplacement, NativeInput };

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

static BOOL writable(AXUIElementRef element, CFStringRef key) {
    Boolean allowed = false;
    return AXUIElementIsAttributeSettable(element, key, &allowed) == kAXErrorSuccess && allowed;
}

static BOOL readSelection(AXUIElementRef element, CFRange *range) {
    id selection = attribute(element, kAXSelectedTextRangeAttribute);
    return selection && CFGetTypeID((__bridge CFTypeRef)selection) == AXValueGetTypeID() &&
        AXValueGetValue((__bridge AXValueRef)selection, kAXValueTypeCFRange, range);
}

static BOOL validRange(NSString *value, CFRange range) {
    return range.location >= 0 && range.length >= 0 && (NSUInteger)range.location <= value.length &&
        (NSUInteger)range.length <= value.length - (NSUInteger)range.location;
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

static EditMethod editMethod(AXUIElementRef field) {
    id role = attribute(field, kAXRoleAttribute);
    if (![role isEqual:@"AXTextArea"] && ![role isEqual:@"AXTextField"] && ![role isEqual:@"AXComboBox"]) return NativeInput;

    // AXSelectedText can be settable even in a read-only field. Require
    // stronger evidence for direct mutation and let the native editor decide
    // whether to consume keyboard input when that evidence is missing.
    if (!writable(field, kAXValueAttribute) && ![attribute(field, CFSTR("AXEditable")) isEqual:@YES]) return NativeInput;

    CFArrayRef parameterized = NULL;
    if (AXUIElementCopyParameterizedAttributeNames(field, &parameterized) == kAXErrorSuccess) {
        NSArray *names = CFBridgingRelease(parameterized);
        if ([names containsObject:(__bridge NSString *)replaceRange]) {
            id value = attribute(field, kAXValueAttribute);
            CFRange selection;
            if ([value isKindOfClass:NSString.class] && readSelection(field, &selection) && validRange(value, selection)) {
                return RangeReplacement;
            }
        }
    }
    if (writable(field, kAXSelectedTextAttribute)) return SelectedText;
    return NativeInput;
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
static NSUInteger nativeInputOffset;
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
    NSNumber *request = pendingRequest;
    pendingRequest = nil;
    pendingText = nil;
    nativeInputOffset = 0;
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

static NSString *check(Binding *binding, EditMethod *method) {
    NSString *error = checkTarget(binding);
    if (error) return error;
    EditMethod available = editMethod((__bridge AXUIElementRef)binding.area);
    if (available == NativeInput && !CGPreflightPostEventAccess()) return keyboardPermissionError;
    if (method) *method = available;
    return nil;
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

static NSString *dispatchError(Binding *binding) {
    NSString *error = checkTarget(binding);
    if (error) return error;
    if (!AXIsProcessTrusted()) return permissionError;
    if (IsSecureEventInputEnabled()) return secureInputError;
    if (releaseRequested() || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != binding.pid) return focusError;
    return binding.failed;
}

static NSString *keyboardText(NSString *text) {
    // AppKit can interpret control characters as editing or navigation
    // commands even in a Unicode payload. In this fallback, use spaces for
    // breaks and tabs, and drop remaining key-command characters.
    NSMutableCharacterSet *breaks = [NSCharacterSet.newlineCharacterSet mutableCopy];
    [breaks addCharactersInString:@"\t"];
    NSString *singleBreaks = [text stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"];
    NSString *plain = [[singleBreaks componentsSeparatedByCharactersInSet:breaks] componentsJoinedByString:@" "];
    NSMutableCharacterSet *commands = [NSMutableCharacterSet characterSetWithRange:NSMakeRange(0, 0x20)];
    [commands addCharactersInRange:NSMakeRange(0x7F, 0x21)];
    [commands addCharactersInRange:NSMakeRange(NSUpArrowFunctionKey, NSModeSwitchFunctionKey - NSUpArrowFunctionKey + 1)];
    return [[plain componentsSeparatedByCharactersInSet:commands] componentsJoinedByString:@""];
}

static void insertWhenReleased(void);

static void postText(Binding *binding) {
    NSString *text = nativeInputOffset ? pendingText : keyboardText(pendingText);
    if (!text.length) {
        finishWrite(nil);
        return;
    }
    // Quartz keyboard events carry up to 20 UTF-16 code units. Keep
    // composed sequences together when they fit and never split a surrogate pair.
    enum { maxCodeUnits = 20 };
    UniChar buffer[maxCodeUnits];
    NSUInteger end = MIN(nativeInputOffset + maxCodeUnits, text.length);
    if (end < text.length) {
        NSRange sequence = [text rangeOfComposedCharacterSequenceAtIndex:end];
        if (sequence.location > nativeInputOffset) end = sequence.location;
        else if (CFStringIsSurrogateHighCharacter([text characterAtIndex:end - 1])) end--;
    }
    NSUInteger length = end - nativeInputOffset;
    [text getCharacters:buffer range:NSMakeRange(nativeInputOffset, length)];

    // An unmapped virtual key carries only text for clients that honor the
    // Unicode payload. No event asks the target to read the shared clipboard.
    const CGKeyCode unicodeKey = 0xFF;
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, unicodeKey, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, unicodeKey, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        finishWrite(keyboardError);
        return;
    }
    CGEventSetFlags(down, 0);
    CGEventSetFlags(up, 0);
    CGEventKeyboardSetUnicodeString(down, length, buffer);
    CGEventKeyboardSetUnicodeString(up, length, buffer);
    NSString *error = dispatchError(binding);
    if (!error && !CGPreflightPostEventAccess()) error = keyboardPermissionError;
    BOOL modifiersHeld = shortcutHeld();
    if (!error && !modifiersHeld) {
        CGEventPostToPid(binding.pid, down);
        CGEventPostToPid(binding.pid, up);
    }
    CFRelease(down);
    CFRelease(up);
    if (error) finishWrite(error);
    else if (modifiersHeld) writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
    else if (end == text.length) finishWrite(nil);
    else {
        pendingText = text;
        nativeInputOffset = end;
        notifyWriteWaiting(CFAbsoluteTimeGetCurrent());
        NSNumber *request = pendingRequest;
        dispatch_async(dispatch_get_main_queue(), ^{
            if ([request isEqual:pendingRequest]) insertWhenReleased();
        });
    }
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
    // Keep sending an already-started keyboard delivery with the same method.
    if (nativeInputOffset) {
        postText(binding);
        return;
    }
    EditMethod method;
    NSString *error = check(binding, &method);
    if (error) {
        finishWrite(error);
        return;
    }
    if (method == NativeInput) {
        postText(binding);
        return;
    }
    AXUIElementRef area = (__bridge AXUIElementRef)binding.area;
    NSDictionary *replacement = nil;
    NSString *value = nil;
    CFRange range;
    if (method == RangeReplacement) {
        value = attribute(area, kAXValueAttribute);
        if (![value isKindOfClass:NSString.class] || !readSelection(area, &range) || !validRange(value, range)) {
            postText(binding);
            return;
        }
        id rangeValue = CFBridgingRelease(AXValueCreate(kAXValueTypeCFRange, &range));
        if (!rangeValue) {
            finishWrite(writeError);
            return;
        }
        replacement = @{@"AXReplacementRange": rangeValue, @"AXReplacementText": pendingText};
    }

    EditMethod current;
    error = check(binding, &current);
    if (error) {
        finishWrite(error);
        return;
    }
    if (current != method) {
        postText(binding);
        return;
    }
    // Explicit ranges remain valid only while the value and selection match.
    if (replacement) {
        id currentValue = attribute(area, kAXValueAttribute);
        CFRange currentSelection;
        if (![currentValue isKindOfClass:NSString.class] || !readSelection(area, &currentSelection)) {
            postText(binding);
            return;
        }
        if (![currentValue isEqual:value] || currentSelection.location != range.location || currentSelection.length != range.length) {
            finishWrite(selectionError);
            return;
        }
    }
    error = dispatchError(binding);
    if (error) {
        finishWrite(error);
        return;
    }
    if (shortcutHeld()) {
        writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
        return;
    }
    if (method == RangeReplacement) {
        // The native replacement supports line breaks as text. AXTextOperation
        // can route them through a text event that submits a form.
        CFTypeRef result = NULL;
        AXError status = AXUIElementCopyParameterizedAttributeValue(area, replaceRange,
            (__bridge CFDictionaryRef)replacement, &result);
        id accepted = CFBridgingRelease(result);
        finishWrite(status == kAXErrorSuccess && [accepted isEqual:@YES] ? nil : writeError);
        return;
    }
    AXError status = AXUIElementSetAttributeValue(area, kAXSelectedTextAttribute, (__bridge CFStringRef)pendingText);
    finishWrite(status == kAXErrorSuccess ? nil : writeError);
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
        NSString *error = check(start, NULL);
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
        dispatch_async(dispatch_get_main_queue(), ^{ exit(0); });
    });
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
        readRequests(^(NSDictionary *message) {
            dispatch_async(dispatch_get_main_queue(), ^{ handle(message); });
        });
        [NSApplication.sharedApplication run];
    }
    return 0;
}
