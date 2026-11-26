#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <assert.h>

// The WebKit document view can paste directly from a private board.
// This exercises its native editor without global key events or clipboard writes.
@interface NSView (WebKitPaste)
- (BOOL)readSelectionFromPasteboard:(NSPasteboard *)pasteboard;
@end

static void paste(NSView *document, NSPasteboard *clipboard, NSString *text) {
    [clipboard clearContents];
    assert([clipboard setString:text forType:NSPasteboardTypeString]);
    assert([document readSelectionFromPasteboard:clipboard]);
}

@interface Driver : NSObject <WebFrameLoadDelegate>
@property (strong) NSWindow *window;
@property (strong) WebView *web;
@end

@implementation Driver
- (void)webView:(WebView *)web didFinishLoadForFrame:(WebFrame *)frame {
    if (frame != web.mainFrame) return;
    NSView *document = frame.frameView.documentView;
    assert([self.window makeFirstResponder:document]);
    NSPasteboard *clipboard = [NSPasteboard pasteboardWithUniqueName];

    [web stringByEvaluatingJavaScriptFromString:@"limited.focus(); limited.setSelectionRange(1, 1)"];
    paste(document, clipboard, @"AB東京");
    assert([[web stringByEvaluatingJavaScriptFromString:
        @"String(limited.value === 'xABy' && limited.selectionStart === 3)"] isEqual:@"true"]);

    [web stringByEvaluatingJavaScriptFromString:@"single.focus(); single.setSelectionRange(1, 1)"];
    paste(document, clipboard, @"\n");
    assert([[web stringByEvaluatingJavaScriptFromString:
        @"String(document.activeElement === single && single.value === 'xy' && submits === 0)"] isEqual:@"true"]);
    [clipboard releaseGlobally];
    [NSApplication.sharedApplication stop:nil];
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
        [driver.web.mainFrame loadHTMLString:
            @"<!doctype html><meta charset=utf-8><form><textarea id=limited maxlength=4>xy</textarea>"
            "<input id=single value=xy><button>Submit</button></form>"
            "<script>var submits = 0; document.forms[0].onsubmit = event => { event.preventDefault(); submits++; };</script>"
            baseURL:nil];
        [app run];
        (void)driver;
    }
}
