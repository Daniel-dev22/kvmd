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
// A finger there has to be able to do everything a mouse can -- click where the
// cursor is, right click, middle click -- while a DRAG still moves the cursor
// and two fingers still scroll. Those are told apart by distance and time only,
// never by the element under the finger, which is why this file has no DOM in
// it at all and is unit-tested without a browser.

"use strict";


// A finger never lands still: some slop is a tap, not a drag. Deliberately
// smaller than mouse.js's 15px scroll step, so a wobble that is too small to
// scroll is also too big to click -- the quiet answer is the safe one when the
// other end is someone's server.
export const TAP_SLOP_PX = 10;

// The same 500ms keypad.js uses to latch a key, for the same reason: it is
// about as long as a press can be before it stops feeling like a tap.
export const LONG_PRESS_MS = 500;


// cb(button) is called with "left", "right" or "middle" the moment a gesture is
// recognised. Everything after that -- pressing the button, holding it for a
// believable length of time, releasing it -- belongs to the caller.
export function TouchGestures(cb, deps={}) {
	var self = this;

	/************************************************************************/

	var __setTimer = (deps.setTimer || setTimeout);
	var __clearTimer = (deps.clearTimer || clearTimeout);
	var __now = (deps.now || (() => Date.now()));

	var __origins = new Map(); // Where each finger landed, by identifier
	var __fingers = 0; // The MOST fingers this gesture has held at once
	var __started = 0;
	var __moved = false;
	var __clicked = false; // The long press already produced its click
	var __timer = null;

	/************************************************************************/

	// points: [{"id": <identifier>, "x": <clientX>, "y": <clientY>}, ...],
	// i.e. every finger currently on the surface, not just the new one.
	self.start = function(points) {
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
		if (__fingers === 1 && !__moved && !__clicked) {
			__arm();
		} else {
			// A second finger is a scroll or a middle click, never a right one.
			__disarm();
		}
	};

	self.move = function(points) {
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

	// points: the fingers STILL down (ev.touches). The gesture ends when the
	// last one lifts, not when the first does -- a two-finger tap releases in
	// two events and is one gesture.
	self.end = function(points) {
		__disarm();
		if (points.length > 0) {
			return;
		}
		let button = null;
		if (!__moved && !__clicked && (__now() - __started) <= LONG_PRESS_MS) {
			button = (__fingers === 1 ? "left" : (__fingers === 2 ? "middle" : null));
		}
		__reset();
		if (button) {
			cb(button);
		}
	};

	// A touch the browser or the system took away. It is NOT a tap: the user
	// may never have meant to touch the host at all.
	self.cancel = function() {
		__reset();
	};

	/************************************************************************/

	var __arm = function() {
		__disarm();
		__timer = __setTimer(function() {
			__timer = null;
			if (!__moved && __fingers === 1) {
				__clicked = true;
				cb("right");
			}
		}, LONG_PRESS_MS);
	};

	var __disarm = function() {
		if (__timer !== null) {
			__clearTimer(__timer);
			__timer = null;
		}
	};

	var __reset = function() {
		__disarm();
		__origins.clear();
		__fingers = 0;
		__moved = false;
		__clicked = false;
	};
}
