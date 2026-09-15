/*****************************************************************************
#                                                                            #
#    KVMD - The main PiKVM daemon.                                           #
#                                                                            #
#    Copyright (C) 2018-2024  Maxim Devaev <mdevaev@gmail.com>               #
#                                                                            #
#    This program is free software: you can redistribute it and/or modify    #
#    it under the terms of the GNU General Public License as published by    #
#    the Free Software Foundation, either version 3 of the License, or       #
#    (at your option) any later version.                                     #
#                                                                            #
#    This program is distributed in the hope that it will be useful,         #
#    but WITHOUT ANY WARRANTY; without even the implied warranty of          #
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the           #
#    GNU General Public License for more details.                            #
#                                                                            #
#    You should have received a copy of the GNU General Public License       #
#    along with this program.  If not, see <https://www.gnu.org/licenses/>.  #
#                                                                            #
*****************************************************************************/


"use strict";


import {tools, $} from "../tools.js";
import {HOVER_QUERY, UI_MOBILE} from "../ui.js";
import {wm} from "../wm.js";
import {Keypad} from "../keypad.js";
import {TouchGestures} from "../gestures.js";
import {makeZoom, ZOOM_MIN, ZOOM_MAX} from "./zoom.js";


// A real click has a duration. It also makes the on-screen Left button visibly
// flash, which is the only acknowledgement a phone user gets that their tap
// became a click -- there is no cursor under their finger to watch.
const CLICK_MS = 50;

// Every button the pad can latch. A latched button means a drag is in progress
// on the host, and a gesture must not interfere with one.
const BUTTONS = ["left", "middle", "right", "up", "down"];


export function Mouse(__getGeometry, __recordWsEvent) {
	var self = this;

	/************************************************************************/

	var __ws = null;
	var __online = true;
	var __abs = true;

	var __keypad = null;
	var __gestures = null;
	var __zoom = null;
	var __pinch = null; // The previous two-finger frame, while one is in progress

	var __timer = null;

	var __touch_pos = null;
	var __click_timers = {};
	// Whether the gesture under way is allowed to click at all, decided once
	// when the first finger lands -- see __tapClickAllowed().
	var __gesture_live = false;

	var __abs_pos = null;
	var __rel_deltas = [];

	var __init__ = function() {
		__keypad = new Keypad($("mouse-buttons"), __sendButton);
		__zoom = new makeZoom();

		// Where the view starts on every load. A phone cannot read a 1920x1080
		// console at 1x -- 4.8px per character -- and zooming in by hand after
		// every page load is not a thing anyone should have to do.
		tools.storage.bindSimpleSlider($("stream-zoom-slider"), "stream.zoom", ZOOM_MIN, ZOOM_MAX, 0.25, 2, function(value) {
			$("stream-zoom-value").innerText = `${Math.round(value * 100)}%`;
			__resetZoom(value);
		});

		__gestures = new TouchGestures({
			"onClick": __touchClick,
			// "A right click is ready; lift to send it." The keypad learned
			// this lesson first: a 500ms promotion that arrives with no warning
			// is not something a user can consent to.
			"onArm": (on) => $("stream-box").classList.toggle("stream-box-click-armed", on),
		});

		tools.storage.bindSimpleSlider($("hid-mouse-sens-slider"), "hid.mouse.sens", 0.1, 1.9, 0.1, 1.0, function (value) {
			$("hid-mouse-sens-value").innerText = value.toFixed(1);
		});

		tools.storage.bindSimpleSlider($("hid-mouse-boost-slider"), "hid.mouse.boost", 1, 10, 1, 1, function (value) {
			$("hid-mouse-boost-value").innerText = "x" + value;
		});

		tools.storage.bindSimpleSlider($("hid-mouse-scroll-slider"), "hid.mouse.scroll_rate", 1, 25, 1, 5, function (value) {
			$("hid-mouse-scroll-value").innerText = value;
		});

		tools.storage.bindSimpleSlider($("hid-mouse-rate-slider"), "hid.mouse.rate", 10, 100, 10, 10, function (value) {
			$("hid-mouse-rate-value").innerText = value + " ms";
			if (__timer) {
				clearInterval(__timer);
			}
			__timer = setInterval(__sendPlannedMove, value);
		});

		document.addEventListener("pointerlockchange", __relativeCapturedHandler); // Only for relative
		document.addEventListener("pointerlockerror", __relativeCapturedHandler);

		$("stream-box").addEventListener("contextmenu", (ev) => ev.preventDefault());
		$("stream-box").addEventListener("mouseenter", __updateOnlineLeds);
		$("stream-box").addEventListener("mouseenter", __enterButtonsHandler);
		$("stream-box").addEventListener("mouseleave", __updateOnlineLeds);
		$("stream-box").addEventListener("mouseleave", __leaveButtonsHandler);
		$("stream-box").addEventListener("mousedown", (ev) => __streamButtonHandler(ev, true));
		$("stream-box").addEventListener("mouseup", (ev) => __streamButtonHandler(ev, false));
		$("stream-box").addEventListener("mousemove", __streamMoveHandler);
		$("stream-box").addEventListener("wheel", __streamScrollHandler);

		$("stream-box").addEventListener("touchstart", __streamTouchStartHandler);
		$("stream-box").addEventListener("touchmove", __streamTouchMoveHandler);
		$("stream-box").addEventListener("touchend", __streamTouchEndHandler);
		// A cancelled touch never produces a touchend. Without this the button
		// stays pressed on the host after a system gesture or an incoming call,
		// and a gesture the user never finished would be read as a tap.
		$("stream-box").addEventListener("touchcancel", __streamTouchCancelHandler);

		tools.storage.bindSimpleSwitch($("hid-mouse-tap-click-switch"), "hid.mouse.tap_click", true);
		tools.storage.bindSimpleSwitch($("hid-mouse-squash-switch"), "hid.mouse.squash", true);
		tools.storage.bindSimpleSwitch($("hid-mouse-reverse-scrolling-y-switch"), "hid.mouse.reverse_scrolling", false);
		tools.storage.bindSimpleSwitch($("hid-mouse-reverse-scrolling-x-switch"), "hid.mouse.reverse_panning", false);
		let cumulative_scrolling = !(tools.browser.is_firefox && !tools.browser.is_mac);
		tools.storage.bindSimpleSwitch($("hid-mouse-cumulative-scrolling-switch"), "hid.mouse.cumulative_scrolling", cumulative_scrolling);
		tools.storage.bindSimpleSwitch($("hid-mouse-dot-switch"), "hid.mouse.dot", true, __updateOnlineLeds);

		__updateOnlineLeds();
	};

	/************************************************************************/

	self.setSocket = function(ws) {
		__ws = ws;
		if (!__abs && __isRelativeCaptured()) {
			document.exitPointerLock();
		}
		__updateOnlineLeds();
	};

	self.setState = function(online, abs, hid_online, hid_busy) {
		if (!hid_online) {
			__online = null;
		} else {
			__online = (online && !hid_busy);
		}
		if (!__abs && abs && __isRelativeCaptured()) {
			document.exitPointerLock();
		}
		if (__abs && !abs) {
			__touch_pos = null;
			__rel_deltas = [];
		}
		__abs = abs;
		__updateOnlineLeds();
	};

	self.releaseAll = function() {
		__keypad.releaseAll();
	};

	var __leave_buttons = 0;

	var __leaveButtonsHandler = function(ev) {
		// https://github.com/pikvm/pikvm/issues/1653
		__leave_buttons = ev.buttons;
	};

	var __enterButtonsHandler = function(ev) {
		if (ev.buttons !== __leave_buttons) {
			self.releaseAll();
		}
		__leave_buttons = 0;
	};

	var __updateOnlineLeds = function() {
		let is_captured;
		if (__abs) {
			is_captured = (
				!window.matchMedia(HOVER_QUERY).matches
				|| $("stream-box").matches("#stream-box:hover")
			);
			let dot = $("hid-mouse-dot-switch").checked;
			$("stream-box").classList.toggle("stream-box-mouse-dot", (__ws && is_captured && dot));
			$("stream-box").classList.toggle("stream-box-mouse-none", (__ws && is_captured && !dot));
			$("stream-box").classList.toggle("stream-box-mouse-waitrel", false);
		} else {
			is_captured = __isRelativeCaptured();
			$("stream-box").classList.toggle("stream-box-mouse-dot", false);
			$("stream-box").classList.toggle("stream-box-mouse-none", false);
			$("stream-box").classList.toggle("stream-box-mouse-waitrel", (__ws && !is_captured));
		}

		let led = "led-gray";
		let title = "Mouse free";
		if (__ws) {
			if (__online === null) {
				led = "led-red";
				title = (is_captured ? "Mouse captured, emulator offline" : "Mouse free, emulator offline");
			} else if (__online) {
				if (is_captured) {
					led = "led-green";
					title = "Mouse captured";
				}
			} else {
				led = "led-yellow";
				title = (is_captured ? "Mouse captured, inactive/busy" : "Mouse free, inactive/busy");
			}
		} else {
			if (is_captured) {
				title = "Mouse captured, PiKVM offline";
			}
		}
		$("hid-mouse-led").className = led;
		$("hid-mouse-led").title = title;
	};

	var __isRelativeCaptured = function() {
		return (document.pointerLockElement === $("stream-box"));
	};

	var __relativeCapturedHandler = function() {
		tools.info("Relative mouse", (__isRelativeCaptured() ? "captured" : "released"), "by pointer lock");
		__updateOnlineLeds();
	};

	var __streamButtonHandler = function(ev, state) {
		// https://www.w3schools.com/jsref/event_button.asp
		ev.preventDefault();
		if (__abs || __isRelativeCaptured()) {
			switch (ev.button) {
				case 0: __keypad.emit("left", state); break;
				case 2: __keypad.emit("right", state); break;
				case 1: __keypad.emit("middle", state); break;
				case 3: __keypad.emit("up", state); break;
				case 4: __keypad.emit("down", state); break;
			}
		} else if (!__abs && !__isRelativeCaptured() && !state) {
			let el = $("stream-box");
			el.requestPointerLock({"unadjustedMovement": true}).catch(function(error) {
				tools.info("Relative mouse: unadjustedMovement is unsupported, running without it");
				if (error.name == "NotSupportedError") {
					el.requestPointerLock();
				}
			});
		}
	};

	var __streamTouchStartHandler = function(ev) {
		// One finger is ours: preventDefault stops the page panning under it and
		// stops the browser replaying the whole gesture as mouse events. TWO is
		// the browser's -- it is the only way to zoom into the host's console on
		// a phone, and a 1920x1080 console on a 390px screen is 4.8px per
		// character. Preventing it here is what made the page unpinchable:
		// 📏 the same synthesized pinch takes the launcher from scale 1 to 2.5
		// and left /kvm at 1.
		if (ev.targetTouches.length === 1) {
			ev.preventDefault();
		}
		if (ev.targetTouches.length === 1) {
			// The first finger on the video: this is where a gesture begins,
			// and the only honest moment to decide whether it may click.
			__gesture_live = __tapClickAllowed();
		}
		if (__gesture_live) {
			__gestures.start(__getTouchPoints(ev));
		}
		let pos = __getTouchPosition(ev, 0);
		if (__abs && ev.touches.length === 1) {
			__abs_pos = pos;
			__sendPlannedMove();
		} else if (!__abs) {
			__touch_pos = pos;
			__abs_pos = null;
		}
	};

	// The picture, moved and scaled. Not the box: the overlays inside it are
	// positioned in the box's own coordinates and would be dragged off with it.
	var __applyZoom = function() {
		let z = __zoom.get();
		let css = (z.scale === ZOOM_MIN ? "" : `translate(${Math.round(z.x)}px, ${Math.round(z.y)}px) scale(${z.scale})`);
		for (let id of ["stream-image", "stream-video", "stream-canvas"]) {
			$(id).style.transform = css;
		}
	};

	var __resetZoom = function(scale) {
		let box = $("stream-box").getBoundingClientRect();
		__zoom.setViewport(box.width, box.height);
		__zoom.reset();
		if (document.documentElement.getAttribute("data-ui") === UI_MOBILE && scale > ZOOM_MIN) {
			// Anchored at the top-left, where a console's prompt is.
			__zoom.pinch(scale, {"x": 0, "y": 0});
		}
		__applyZoom();
	};

	// Where a touch is on the PICTURE, which is what the host is told about. At
	// 1x this is where the finger is; zoomed in, it is not, and a click that
	// skips this lands a third of the way to where you meant it.
	var __streamPosition = function(client_x, client_y) {
		let rect = $("stream-box").getBoundingClientRect();
		return __zoom.toPicture({"x": client_x - rect.left, "y": client_y - rect.top});
	};

	var __twoFingers = function(ev) {
		let a = ev.targetTouches[0];
		let b = ev.targetTouches[1];
		return {
			"dist": Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)),
			"x": (a.clientX + b.clientX) / 2,
			"y": (a.clientY + b.clientY) / 2,
		};
	};

	var __streamTouchMoveHandler = function(ev) {
		if (ev.targetTouches.length === 1) {
			ev.preventDefault();
		}
		if (__gesture_live) {
			__gestures.move(__getTouchPoints(ev));
		}
		let pos = __getTouchPosition(ev, 0);
		if (ev.touches.length === 1) {
			if (__abs) {
				__abs_pos = pos;
			} else if (__touch_pos !== null) {
				__sendOrPlanRelativeMove({
					"x": (pos.x - __touch_pos.x),
					"y": (pos.y - __touch_pos.y),
				});
				__touch_pos = pos;
			}
		} else if (ev.targetTouches.length >= 2) {
			// Two fingers move the VIEW, not the host: pinch to zoom, drag to
			// pan. The host's wheel is the Up/Down pair on the mouse pad, which
			// needs no gesture and cannot be claimed by the browser.
			let now = __twoFingers(ev);
			if (__pinch !== null) {
				let rect = $("stream-box").getBoundingClientRect();
				__zoom.setViewport(rect.width, rect.height);
				__zoom.pan(now.x - __pinch.x, now.y - __pinch.y);
				__zoom.pinch(now.dist / __pinch.dist, {"x": now.x - rect.left, "y": now.y - rect.top});
				__applyZoom();
			}
			__pinch = now;
			__abs_pos = null;
		}
	};

	var __streamTouchEndHandler = function(ev) {
		if (ev.targetTouches.length === 0) {
			ev.preventDefault();
		}
		__sendPlannedMove();
		__touch_pos = null;
		if (__gesture_live) {
			__gestures.end(__getTouchPoints(ev));
		}
		if (ev.targetTouches.length === 0) {
			__gesture_live = false;
		}
		if (ev.targetTouches.length < 2) {
			__pinch = null;
		}
	};

	var __streamTouchCancelHandler = function(ev) {
		if (__gesture_live) {
			__gestures.cancel(__getTouchPoints(ev));
		}
		__sendPlannedMove();
		__touch_pos = null;
		__pinch = null;
		if (ev.targetTouches.length === 0) {
			__gesture_live = false;
		}
	};

	// Decided once per gesture, because every one of these can change while a
	// finger is down and a gesture that started innocently must not become a
	// click halfway through.
	var __tapClickAllowed = function() {
		if (!$("hid-mouse-tap-click-switch").checked) {
			return false;
		}
		if (wm.isMenuOpen()) {
			// The tap that dismisses a sheet lands on the video underneath it.
			// Dismissing something is not clicking the host.
			return false;
		}
		// A latched button is a drag in progress on the host. emit() would
		// release it -- and __unholdAll() would drop it even for another
		// button -- so the video stops clicking until the drag is finished.
		return !BUTTONS.some((code) => __keypad.isCodeActive(code));
	};

	var __touchClick = function(button) {
		// A tap is a click on the host. In absolute mode the cursor is already
		// under the finger; in relative mode this is a trackpad, and the click
		// lands where the host's own cursor is.
		if (__keypad.isCodeActive(button)) {
			// emit(code, true) on a key that is already down RELEASES it. A
			// latched button belongs to the user, not to this gesture.
			return;
		}
		if (__click_timers[button]) {
			// Tapping again before the previous click has finished: end it
			// first, so a double tap is two clicks rather than one long press.
			clearTimeout(__click_timers[button]);
			__keypad.emit(button, false);
		}
		__keypad.emit(button, true);
		__click_timers[button] = setTimeout(function() {
			__click_timers[button] = null;
			__keypad.emit(button, false);
		}, CLICK_MS);
	};

	var __getTouchPoints = function(ev) {
		// targetTouches, NOT touches: the fingers that started on the video and
		// are still down. `touches` is every contact on the SCREEN, and a touch
		// only ever dispatches to the element it started on -- so a thumb
		// resting below the video appears in every event here and its lift
		// never does, which left the gesture counting two fingers forever.
		let points = [];
		for (let touch of ev.targetTouches) {
			points.push({"id": touch.identifier, "x": touch.clientX, "y": touch.clientY});
		}
		return points;
	};

	var __getTouchPosition = function(ev, index) {
		let touch = ev.touches[index];
		// Against the BOX, never against ev.target: the target is whichever of
		// the stacked picture elements was under the finger, and each of them
		// carries the zoom transform, so its own rect is already scaled.
		return (touch ? __streamPosition(touch.clientX, touch.clientY) : null);
	};

	var __streamMoveHandler = function(ev) {
		if (__abs) {
			let pos = __streamPosition(ev.clientX, ev.clientY);
			__abs_pos = {"x": Math.max(pos.x, 0), "y": Math.max(pos.y, 0)};
		} else if (__isRelativeCaptured()) {
			__sendOrPlanRelativeMove({
				"x": ev.movementX,
				"y": ev.movementY,
			});
		}
	};

	var __scroll_delta = {"x": 0, "y": 0};

	var __streamScrollHandler = function(ev) {
		// https://learn.javascript.ru/mousewheel
		// https://stackoverflow.com/a/24595588
		ev.preventDefault();
		if (!__abs && !__isRelativeCaptured()) {
			return;
		}
		let delta = {"x": 0, "y": 0};
		if ($("hid-mouse-cumulative-scrolling-switch").checked) {
			let fix = (tools.browser.is_mac ? 5 : 1);
			for (let [dir, cur] of [["x", ev.deltaX], ["y", ev.deltaY]]) {
				let prev = __scroll_delta[dir];
				if (prev && Math.sign(prev) !== Math.sign(cur)) {
					delta[dir] = prev;
					__scroll_delta[dir] = 0;
				} else {
					__scroll_delta[dir] += cur * fix;
					cur = __scroll_delta[dir];
					if (Math.abs(cur) >= 100) {
						delta[dir] = cur;
						__scroll_delta[dir] = 0;
					}
				}
			}
		} else {
			delta.x = ev.deltaX;
			delta.y = ev.deltaY;
		}
		__sendScroll(delta);
	};

	/************************************************************************/

	var __sendOrPlanRelativeMove = function(delta) {
		// Zoomed in, a finger crossing 30px of glass has crossed 15px of the
		// host's screen. Without this the cursor runs away from the finger.
		let scale = __zoom.get().scale;
		delta = {"x": delta.x / scale, "y": delta.y / scale};
		let sens = $("hid-mouse-sens-slider").valueAsNumber;
		let boost = $("hid-mouse-boost-slider").valueAsNumber;
		delta = {
			"x": Math.min(Math.max(-127, Math.floor(delta.x * sens * boost)), 127),
			"y": Math.min(Math.max(-127, Math.floor(delta.y * sens * boost)), 127),
		};
		if (delta.x || delta.y) {
			if ($("hid-mouse-squash-switch").checked) {
				__rel_deltas.push(delta);
			} else {
				tools.debug("Mouse: relative:", delta);
				__sendEvent("mouse_relative", {"delta": delta});
			}
		}
	};

	var __sendPlannedMove = function() {
		if (__abs) {
			if (__abs_pos !== null) {
				let geo = __getGeometry();
				let to = {
					"x": tools.remap(__abs_pos.x - geo.x, 0, geo.width - 1, -32768, 32767),
					"y": tools.remap(__abs_pos.y - geo.y, 0, geo.height - 1, -32768, 32767),
				};
				tools.debug("Mouse: abs:", to);
				__sendEvent("mouse_move", {"to": to});
			}
		} else if (__rel_deltas.length) {
			tools.debug("Mouse: relative:", __rel_deltas);
			__sendEvent("mouse_relative", {"delta": __rel_deltas, "squash": true});
		}
		__abs_pos = null;
		__rel_deltas = [];
	};

	var __sendButton = function(button, state) {
		tools.debug("Mouse: button", (state ? "pressed:" : "released:"), button);
		__sendPlannedMove();
		__sendEvent("mouse_button", {"button": button, "state": state});
	};

	var __sendScroll = function(delta) {
		// Send a single scroll step defined by rate
		let rate = $("hid-mouse-scroll-slider").valueAsNumber;
		for (let dir of ["x", "y"]) {
			if (delta[dir]) {
				delta[dir] = Math.sign(delta[dir]) * (-rate);
				if ($(`hid-mouse-reverse-scrolling-${dir}-switch`).checked) {
					delta[dir] *= -1;
				}
			}
		}
		if (delta.x || delta.y) {
			tools.debug("Mouse: scrolled:", delta);
			__sendEvent("mouse_wheel", {"delta": delta});
		}
	};

	var __sendEvent = function(ev_type, ev) {
		ev = {"event_type": ev_type, "event": ev};
		if (__ws && !$("hid-mute-switch").checked) {
			__ws.sendHidEvent(ev);
		}
		__recordWsEvent(ev);
	};

	__init__();
}
