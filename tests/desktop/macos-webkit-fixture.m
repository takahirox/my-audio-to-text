#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <assert.h>

// Exercise the installed WebKit editor in a fixture-owned window. AppKit's
// AXReplaceRangeWithText selector delegates to this WebKit method. Driving
// the same method here requires no cross-application accessibility access.
@interface NSObject (WebKitRangeReplacement)
- (BOOL)accessibilityReplaceRange:(NSRange)range withText:(NSString *)text;
@end

@interface Driver : NSObject <WebFrameLoadDelegate>
@property (strong) NSWindow *window;
@property (strong) WebView *web;
@end

@implementation Driver
- (void)webView:(WebView *)web didFinishLoadForFrame:(WebFrame *)frame {
    if (frame != web.mainFrame) return;
    NSView *document = frame.frameView.documentView;
    [self.window makeFirstResponder:document];

    [web stringByEvaluatingJavaScriptFromString:@"notes.focus(); notes.setSelectionRange(5, 5)"];
    id field = [document accessibilityFocusedUIElement];
    assert([[field accessibilityAttributeValue:@"AXRole"] isEqual:@"AXTextArea"]);
    assert([field accessibilityReplaceRange:NSMakeRange(5, 0) withText:@" 東京🙂\n か\u3099"]);
    assert([[web stringByEvaluatingJavaScriptFromString:@"String(notes.value === 'left| 東京🙂\\n か\\u3099right' && "
        "notes.selectionStart === 'left| 東京🙂\\n か\\u3099'.length && document.activeElement === notes)"] isEqual:@"true"]);

    [web stringByEvaluatingJavaScriptFromString:
        @"notes.setSelectionRange(5, 5); notes.addEventListener('beforeinput', () => other.focus(), {once:true})"];
    assert([field accessibilityReplaceRange:NSMakeRange(5, 0) withText:@"再"]);
    assert([[web stringByEvaluatingJavaScriptFromString:
        @"String(notes.value === 'left|再 東京🙂\\n か\\u3099right' && other.value === 'untouched')"] isEqual:@"true"]);

    [web stringByEvaluatingJavaScriptFromString:@"limited.focus(); limited.setSelectionRange(1, 1)"];
    field = [document accessibilityFocusedUIElement];
    assert([field accessibilityReplaceRange:NSMakeRange(1, 0) withText:@"字🙂"]);
    assert([[web stringByEvaluatingJavaScriptFromString:@"limited.value"] isEqual:@"x字y"]);

    [web stringByEvaluatingJavaScriptFromString:@"single.focus(); single.setSelectionRange(1, 1)"];
    field = [document accessibilityFocusedUIElement];
    assert([field accessibilityReplaceRange:NSMakeRange(1, 0) withText:@"\n"]);
    assert([[web stringByEvaluatingJavaScriptFromString:
        @"String(single.value === 'xy' && submits === 0 && other.value === 'untouched')"] isEqual:@"true"]);
    exit(0);
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        Driver *driver = [Driver new];
        driver.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 440, 240)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        driver.web = [[WebView alloc] initWithFrame:driver.window.contentView.bounds];
        driver.web.frameLoadDelegate = driver;
        driver.window.contentView = driver.web;
        [driver.window makeKeyAndOrderFront:nil];
        [driver.web.mainFrame loadHTMLString:
            @"<!doctype html><meta charset=utf-8><form><textarea id=notes>left|right</textarea>"
            "<textarea id=limited maxlength=3>xy</textarea><input id=single value=xy>"
            "<input id=other value=untouched><button>Submit</button></form>"
            "<script>var submits = 0; document.forms[0].onsubmit = event => { event.preventDefault(); submits++; };</script>"
            baseURL:nil];
        [app run];
        (void)driver;
    }
}
