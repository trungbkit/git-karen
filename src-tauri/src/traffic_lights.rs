//! macOS window buttons, inset so they sit centred in the tab bar.
//!
//! tao's own `traffic_light_position` re-applies its offset on every redraw, fullscreen included. In fullscreen
//! AppKit moves the buttons into a separate titlebar window, so that offset (computed from the main window's
//! height) pushes them off-screen and they never come back. Instead, like Electron, the buttons are repositioned
//! only when AppKit lays them out again (resize, leaving fullscreen, key changes) and left alone in fullscreen.

use std::cell::RefCell;
use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSWindow, NSWindowButton, NSWindowDidBecomeKeyNotification, NSWindowDidExitFullScreenNotification,
    NSWindowDidResignKeyNotification, NSWindowDidResizeNotification, NSWindowStyleMask, NSWindowWillCloseNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter};
use tauri::WebviewWindow;

/// Close button's left edge and the titlebar height above it, in points (matches the tab bar's 38px height).
const INSET_X: f64 = 14.0;
const INSET_Y: f64 = 20.0;

/// Positions the buttons now and keeps them there for the life of the window. Must run on the main thread.
pub fn install(window: &WebviewWindow) {
    let (Some(_mtm), Ok(ptr)) = (MainThreadMarker::new(), window.ns_window()) else { return };
    // SAFETY: tauri hands out the live NSWindow of this webview window; it is retained here for setup only.
    let Some(ns_window) = (unsafe { Retained::retain(ptr.cast::<NSWindow>()) }) else { return };
    reposition(&ns_window);

    let center = NSNotificationCenter::defaultCenter();
    // The blocks get the window from the notification rather than capturing it, which would keep it alive forever.
    let on_layout = RcBlock::new(|note: NonNull<NSNotification>| {
        if let Some(window) = unsafe { note.as_ref() }.object().and_then(|o| o.downcast::<NSWindow>().ok()) {
            reposition(&window);
        }
    });
    let observers: Rc<RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>>> = Rc::default();
    for name in [
        unsafe { NSWindowDidResizeNotification },
        unsafe { NSWindowDidExitFullScreenNotification },
        unsafe { NSWindowDidBecomeKeyNotification },
        unsafe { NSWindowDidResignKeyNotification },
    ] {
        let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), Some(&ns_window), None, &on_layout) };
        observers.borrow_mut().push(token);
    }
    let on_close = RcBlock::new({
        let observers = observers.clone();
        move |_: NonNull<NSNotification>| {
            let center = NSNotificationCenter::defaultCenter();
            for token in observers.borrow_mut().drain(..) {
                unsafe { center.removeObserver(token.as_ref()) };
            }
        }
    });
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWindowWillCloseNotification), Some(&ns_window), None, &on_close) };
    observers.borrow_mut().push(token);
}

fn reposition(window: &NSWindow) {
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let (Some(close), Some(minimize), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return;
    };
    // SAFETY: plain view-hierarchy reads on the main thread
    let Some(titlebar) = (unsafe { close.superview().and_then(|v| v.superview()) }) else { return };

    // grow the titlebar container so the buttons, which keep their offset from its bottom, move down
    let close_frame = close.frame();
    let height = close_frame.size.height + INSET_Y;
    let mut frame = titlebar.frame();
    frame.size.height = height;
    frame.origin.y = window.frame().size.height - height;
    titlebar.setFrame(frame);

    let spacing = minimize.frame().origin.x - close_frame.origin.x;
    for (i, button) in [close, minimize, zoom].into_iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = INSET_X + i as f64 * spacing;
        button.setFrameOrigin(origin);
    }
}
