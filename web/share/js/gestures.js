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

// Telling a tap from a drag, on the one surface where a touch cannot simply
// mean "press what is under my finger": the video of the host.
//
// A finger there has to be able to click where the cursor is and right click,
// while a DRAG still moves the cursor. (Two fingers are not this module's: they
// zoom and pan the view, in kvm/mouse.js and kvm/zoom.js. It still has to know
// about them, because a gesture that grew a second finger is not a click.)
// Those are told apart by distance and time only, never by the element,
// which is why this file has no DOM in it at all and is unit-tested without a
// browser.
//
// The other end of this is somebody's server, often at a BIOS prompt, so every
// ambiguous case resolves to SENDING NOTHING. Two deliberate consequences:
//
//   * There is no two-finger middle click. A two-finger tap cannot be told
//     apart from a two-finger scroll that did not travel far enough, which is
//     the gesture an operator makes by reflex on a video pane -- and a middle
//     click pastes the X11 PRIMARY selection, which at a root shell executes
//     whatever it holds. Middle click is on the on-screen Mouse pad, where it
//     is asked for rather than guessed.
//
//   * The right click is ARMED at 500ms and committed when the finger LIFTS,
//     inside a bounded window. The user can see it coming and can still abandon
//     it by moving; a finger simply resting on the screen runs past the window
//     and sends nothing.

"use strict";


// A finger never lands still: this much slop is still a tap.
export const TAP_SLOP_PX = 10;

// The same 500ms keypad.js uses to latch a key, for the same reason: about as
// long as a press can be before it stops feeling like a tap.
export const LONG_PRESS_MS = 500;

// ...and past this, it stops feeling like a press at all. A finger left on the
// screen while reading is not asking for anything.
export const LONG_PRESS_MAX_MS = 2000;


// onClick(button) is called with "left" or "right" the moment a gesture is
// recognised; onArm(bool) whenever the right click becomes (un)available, so
// the surface can show it. Pressing the button, holding it for a believable
// length of time and releasing it belong to the caller.
//
// Every points argument is the fingers that started on THIS element and are
// still down -- ev.targetTouches, never ev.touches. `touches` is every contact
// on the screen, including fingers resting on other elements whose lift this
// element is never told about, which is how a thumb parked below the video
// turned the next ordinary tap into a two-finger gesture.
export function TouchGestures({onClick, onArm}, deps={}) {
	var self = this;

	/************************************************************************/

	var __setTimer = (deps.setTimer || setTimeout);
	var __clearTimer = (deps.clearTimer || clearTimeout);
	var __now = (deps.now || (() => Date.now()));

	var __origins = new Map(); // Where each finger landed, by identifier
	var __fingers = 0; // The MOST fingers this gesture has held at once
	var __started = 0;
	var __moved = false;
	var __dead = false; // Cancelled, and fingers are still down
	var __armed = false;
	var __arm_timer = null;
	var __expire_timer = null;

	/************************************************************************/

	self.start = function(points) {
		if (__dead) {
			return;
		}
		if (__fingers === 0) {
			__reset();
			__started = __now();
		}
		for (let point of points) {
			if (!__origins.has(point.id)) {
				__origins.set(point.id, {"x": point.x, "y": point.y});
			}
		}
		__fingers = Math.max(__fingers, points.length);
		if (__fingers === 1 && !__moved) {
			__armLater();
		} else {
			// A second finger is a scroll, never a click.
			__disarm();
		}
	};

	self.move = function(points) {
		if (__dead) {
			return;
		}
		for (let point of points) {
			let origin = __origins.get(point.id);
			if (origin && (
				Math.abs(point.x - origin.x) > TAP_SLOP_PX
				|| Math.abs(point.y - origin.y) > TAP_SLOP_PX
			)) {
				__moved = true;
			}
		}
		if (__moved) {
			__disarm();
		}
	};

	// The gesture ends when the LAST finger lifts, not when the first does.
	self.end = function(points) {
		if (points.length > 0) {
			// An identifier is reusable the moment its touch ends, so a finger
			// landing later could inherit this one's origin and look like it
			// had travelled the distance between them.
			let live = new Set(points.map((point) => point.id));
			for (let id of [...__origins.keys()]) {
				if (!live.has(id)) {
					__origins.delete(id);
				}
			}
			__disarm();
			return;
		}
		let armed = __armed;
		let elapsed = (__now() - __started);
		let tapped = (__fingers === 1 && !__moved && !__dead);
		__reset();
		__dead = false;
		if (!tapped) {
			return;
		}
		if (armed) {
			onClick("right");
		} else if (elapsed < LONG_PRESS_MS) {
			onClick("left");
		}
		// Longer than the armed window: a finger was resting, not pressing.
	};

	// A touch the browser or the system took away -- a back-swipe, a shade
	// pull, an incoming call. It is not a tap, and neither is whatever the
	// fingers still on the screen do next: they are the tail of a gesture the
	// user has already lost, so nothing counts again until the screen is clear.
	self.cancel = function(points) {
		__reset();
		__dead = (points.length > 0);
	};

	/************************************************************************/

	var __armLater = function() {
		__disarm();
		__arm_timer = __setTimer(function() {
			__arm_timer = null;
			__setArmed(true);
			__expire_timer = __setTimer(function() {
				__expire_timer = null;
				__setArmed(false);
			}, (LONG_PRESS_MAX_MS - LONG_PRESS_MS));
		}, LONG_PRESS_MS);
	};

	var __disarm = function() {
		for (let timer of [__arm_timer, __expire_timer]) {
			if (timer !== null) {
				__clearTimer(timer);
			}
		}
		__arm_timer = null;
		__expire_timer = null;
		__setArmed(false);
	};

	var __setArmed = function(on) {
		if (__armed !== on) {
			__armed = on;
			onArm(on);
		}
	};

	var __reset = function() {
		__disarm();
		__origins.clear();
		__fingers = 0;
		__moved = false;
	};
}
