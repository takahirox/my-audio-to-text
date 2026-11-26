#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <signal.h>
#import <stdio.h>

static NSString *const permissionError =
    @"Allow My Audio to Text in System Settings → Privacy & Security → Device Control and Data Access (Accessibility), then start again.";
static NSString *const targetError =
    @"Focus an editable text field that exposes Accessibility editing and try again.";
static NSString *const focusError = @"The authorized window or text field changed or lost focus.";
static NSString *const selectionError = @"The text or selection changed before the edit. Voice typing stopped.";
static NSString *const writeError = @"The focused field rejected the Accessibility edit. Voice typing stopped.";
static NSString *const pastePermissionError =
    @"Allow My Audio to Text to post keyboard events under Accessibility in System Settings → Privacy & Security, then start again.";
static NSString *const pasteboardError =
    @"The clipboard changed or could not be preserved for native paste. Voice typing stopped.";
static CFStringRef const replaceRange = CFSTR("AXReplaceRangeWithText");

typedef NS_ENUM(NSInteger, EditMethod) { Unavailable, SelectedText, RangeReplacement, NativePaste };

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

static BOOL hasSameTextAndSelection(AXUIElementRef element, NSString *value, CFRange range) {
    CFRange currentSelection;
    return [attribute(element, kAXValueAttribute) isEqual:value] &&
        readSelection(element, &currentSelection) &&
        currentSelection.location == range.location && currentSelection.length == range.length;
}

static EditMethod editMethod(AXUIElementRef field, AXUIElementRef window) {
    if (!field || !window) return Unavailable;
    id role = attribute(field, kAXRoleAttribute);
    if (![role isEqual:@"AXTextArea"] && ![role isEqual:@"AXTextField"]) return Unavailable;
    CFTypeRef subrole = NULL;
    AXError status = AXUIElementCopyAttributeValue(field, kAXSubroleAttribute, &subrole);
    id fieldSubrole = CFBridgingRelease(subrole);
    if ((status != kAXErrorSuccess && status != kAXErrorNoValue && status != kAXErrorAttributeUnsupported) ||
        [fieldSubrole isEqual:@"AXSecureTextField"] ||
        [attribute(field, kAXEnabledAttribute) isEqual:@NO] ||
        [attribute(field, kAXFocusedAttribute) isEqual:@NO] ||
        [attribute(field, CFSTR("AXReadOnly")) isEqual:@YES]) return Unavailable;
    id editable = attribute(field, CFSTR("AXEditable"));
    if ([editable isEqual:@NO]) return Unavailable;
    id owner = elementAttribute(field, kAXWindowAttribute);
    if (owner && !CFEqual((__bridge CFTypeRef)owner, window)) return Unavailable;

    BOOL canEditValue = writable(field, kAXValueAttribute) || [editable isEqual:@YES];
    if (canEditValue) {
        CFArrayRef parameterized = NULL;
        if (AXUIElementCopyParameterizedAttributeNames(field, &parameterized) == kAXErrorSuccess) {
            NSArray *names = CFBridgingRelease(parameterized);
            CFRange selection;
            if ([names containsObject:(__bridge NSString *)replaceRange] &&
                [attribute(field, kAXValueAttribute) isKindOfClass:NSString.class] && readSelection(field, &selection)) {
                return RangeReplacement;
            }
        }
    }
    if (writable(field, kAXSelectedTextAttribute)) return SelectedText;
    return canEditValue ? NativePaste : Unavailable;
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
static CFAbsoluteTime writeAfter;
static CFAbsoluteTime nextWaitingNotice;
// The stdin reader publishes revocations while the main queue is in AX calls.
// Synchronize only this state so the reader never has to wait for an AX call.
static NSMutableSet<NSString *> *releaseRequests;
static BOOL inputClosed;
static BOOL exiting;
static BOOL pasteInFlight;

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
    result.window = elementAttribute(application, kAXFocusedWindowAttribute);
    result.area = elementAttribute(application, kAXFocusedUIElementAttribute);
    if (!result.window || !result.area) {
        result.failed = targetError;
        return result;
    }

    // Notification support varies. Keep every observer the provider supports
    // and recheck the focused window and element even when it supports none.
    AXObserverRef observer = NULL;
    if (AXObserverCreate(pid, focusedChanged, &observer) == kAXErrorSuccess) {
        result.observer = observer;
        AXObserverAddNotification(observer, application, kAXFocusedUIElementChangedNotification, (__bridge void *)result);
        AXObserverAddNotification(observer, application, kAXFocusedWindowChangedNotification, (__bridge void *)result);
        AXObserverAddNotification(observer, (__bridge AXUIElementRef)result.window, kAXUIElementDestroyedNotification,
                                  (__bridge void *)result);
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopCommonModes);
    }
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

static NSString *check(Binding *binding, EditMethod *method) {
    if (binding.failed) return binding.failed;
    if (!AXIsProcessTrusted()) return permissionError;
    if (!hasBoundFocus(binding)) return focusError;
    EditMethod available = editMethod((__bridge AXUIElementRef)binding.area, (__bridge AXUIElementRef)binding.window);
    if (available == Unavailable) return targetError;
    if (available == NativePaste && !CGPreflightPostEventAccess()) return pastePermissionError;
    if (method) *method = available;
    return nil;
}

static BOOL shortcutHeld(void) {
    return held || (GetCurrentKeyModifiers() & (cmdKey | shiftKey | optionKey | controlKey));
}

static BOOL releaseRequested(void) {
    @synchronized (releaseRequests) {
        return inputClosed || (token && [releaseRequests containsObject:token]);
    }
}

static NSArray<NSPasteboardItem *> *copyPasteboardItems(NSPasteboard *pasteboard) {
    if (@available(macOS 15.4, *)) {
        if (pasteboard.accessBehavior == NSPasteboardAccessBehaviorAlwaysDeny) return nil;
    }
    NSMutableArray<NSPasteboardItem *> *copies = [NSMutableArray array];
    NSArray<NSPasteboardItem *> *items = pasteboard.pasteboardItems;
    if (!items && pasteboard.types.count) return nil;
    for (NSPasteboardItem *item in items) {
        NSPasteboardItem *copy = [NSPasteboardItem new];
        for (NSPasteboardType type in item.types) {
            // A file promise needs its original provider when pasted.
            if ([type isEqual:(__bridge NSString *)kPasteboardTypeFileURLPromise]) return nil;
            NSData *data = [item dataForType:type];
            if (!data || ![copy setData:data forType:type]) return nil;
        }
        if (!copy.types.count) return nil;
        [copies addObject:copy];
    }
    return copies;
}

static BOOL restorePasteboard(NSPasteboard *pasteboard, NSInteger generation, NSArray<NSPasteboardItem *> *items) {
    if (pasteboard.changeCount != generation) return NO;
    [pasteboard clearContents];
    return !items.count || [pasteboard writeObjects:items];
}

static void requestExit(void) {
    exiting = YES;
    if (!pasteInFlight) exit(0);
}

static NSString *dispatchError(Binding *binding) {
    if (!hasBoundFocus(binding)) return focusError;
    if (!AXIsProcessTrusted()) return permissionError;
    if (releaseRequested() || exiting) return focusError;
    return nil;
}

static void pasteText(Binding *binding, NSNumber *request, NSString *text) {
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    NSInteger originalGeneration = pasteboard.changeCount;
    NSArray<NSPasteboardItem *> *original = copyPasteboardItems(pasteboard);
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, kVK_ANSI_V, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, kVK_ANSI_V, false);
    if (!original || !down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        finishWrite(original ? writeError : pasteboardError);
        return;
    }
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    EditMethod method;
    NSString *error = check(binding, &method);
    if (!error && method != NativePaste) error = targetError;
    if (!error) error = dispatchError(binding);
    if (!error && shortcutHeld()) {
        CFRelease(down);
        CFRelease(up);
        writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
        return;
    }
    if (!error && pasteboard.changeCount != originalGeneration) error = pasteboardError;
    if (error) {
        CFRelease(down);
        CFRelease(up);
        finishWrite(error);
        return;
    }

    NSInteger generation = [pasteboard clearContents];
    if (![pasteboard setString:text forType:NSPasteboardTypeString]) error = pasteboardError;
    else if (!CGPreflightPostEventAccess()) error = pastePermissionError;
    else error = dispatchError(binding);
    if (!error && pasteboard.changeCount != generation) error = pasteboardError;
    if (error || shortcutHeld()) {
        BOOL restored = restorePasteboard(pasteboard, generation, original);
        CFRelease(down);
        CFRelease(up);
        if (error || !restored) finishWrite(error ?: pasteboardError);
        else writeAfter = CFAbsoluteTimeGetCurrent() + 0.08;
        return;
    }
    waitingForRelease = NO;
    pasteInFlight = YES;
    CGEventPostToPid(binding.pid, down);
    CGEventPostToPid(binding.pid, up);
    CFRelease(down);
    CFRelease(up);

    // The receiving app reads the clipboard asynchronously. Keep writes
    // serialized until it has had time to read, even if this session ends.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        BOOL restored = restorePasteboard(pasteboard, generation, original);
        pasteInFlight = NO;
        if (exiting) exit(0);
        if ([request isEqual:pendingRequest]) {
            finishWrite(dispatchError(binding) ?: (restored ? nil : pasteboardError));
        }
    });
}

static void insertWhenReleased(void) {
    if (!waitingForRelease || pasteInFlight) return;
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
    Binding *binding = bound;
    EditMethod method;
    NSString *error = check(binding, &method);
    if (error) {
        finishWrite(error);
        return;
    }

    AXUIElementRef area = (__bridge AXUIElementRef)binding.area;
    NSDictionary *replacement = nil;
    NSString *value = nil;
    CFRange range;
    if (method == RangeReplacement) {
        value = attribute(area, kAXValueAttribute);
        if (![value isKindOfClass:NSString.class] || !readSelection(area, &range) ||
            range.location < 0 || range.length < 0 || (NSUInteger)range.location > value.length ||
            (NSUInteger)range.length > value.length - (NSUInteger)range.location) {
            finishWrite(selectionError);
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
    if (error || current != method) {
        finishWrite(error ?: targetError);
        return;
    }
    // Explicit ranges remain valid only while the value and selection match.
    if (replacement && !hasSameTextAndSelection(area, value, range)) {
        finishWrite(selectionError);
        return;
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
    if (method == NativePaste) {
        pasteText(binding, pendingRequest, pendingText);
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
        dispatch_async(dispatch_get_main_queue(), ^{ requestExit(); });
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

        // The host may terminate the helper on Quit while native paste is in flight.
        signal(SIGTERM, SIG_IGN);
        dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0,
                                                                dispatch_get_main_queue());
        dispatch_source_set_event_handler(termination, ^{ requestExit(); });
        dispatch_resume(termination);

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
        dispatch_source_cancel(termination);
    }
    return 0;
}
