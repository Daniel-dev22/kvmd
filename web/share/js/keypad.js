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


import {tools} from "./tools.js";


export function Keypad(__el_keypad, __sendKey) {
	var self = this;

	/************************************************************************/

	var __keys = {};
	var __hold_timers = {};

	var __init__ = function() {
		__el_keypad.addEventListener("contextmenu", (ev) => ev.preventDefault());

		for (let el_key of [].slice.call(__el_keypad.getElementsByClassName("key"))) {
			if (el_key.hasAttribute("data-keypad-modifier")) {
				el_key.title = "Tap to hold, again to lock, again to release; long left click or short right click for hold, middle for lock";
			} else if (el_key.hasAttribute("data-keypad-allow-autohold")) {
				el_key.title = "Long left click or short right click for hold, middle for lock";
			} else {
				el_key.title = "Right click for hold, middle for lock";
			}

			let code = el_key.getAttribute("data-keypad-code");

			tools.setDefault(__keys, code, []);
			__keys[code].push(el_key);

			tools.el.setOnDown(el_key, (ev) => __clickHandler(el_key, ev));
			tools.el.setOnUp(el_key, () => __clickHandler(el_key, null));
			el_key.onmouseout = function() {
				if (
					__isActive(el_key, "pressed")
					&& !__isActive(el_key, "holded")
					&& !__isActive(el_key, "locked")
				) {
					__clickHandler(el_key, null);
				}
			};
		}
	};

	/************************************************************************/

	self.isCodeActive = function(code) {
		let keys = __keys[code];
		return (keys !== undefined && keys.length > 0 && __isActive(keys[0]));
	};

	self.releaseAll = function() {
		for (let code in __keys) {
			if (self.isCodeActive(code)) {
				self.emit(code, false);
			}
		}
	};

	self.emit = function(code, state) {
		if (code in __keys) {
			let el_key = __keys[code][0];
			__stopHoldTimer(el_key);
			if (state && !__isActive(el_key)) {
				__deactivate(el_key);
				__activate(el_key, "pressed");
				__process(el_key, true);
			} else {
				__deactivate(el_key);
				__process(el_key, false);
			}
			__unholdAll();
		};
	};

	var __clickHandler = function(el_key, ev) {
		let state = false;
		let act = "pressed";
		if (ev) {
			state = (ev.type === "mousedown" || ev.type === "touchstart");
			if (ev.type === "mousedown") {
				if (ev.button === 1) {
					act = "locked";
				} else if (ev.button === 2) {
					act = "holded";
				}
			} else if (state && __touchLatchHandler(el_key)) {
				return;
			}
		}

		if (state && !__isActive(el_key)) {
			__stopHoldTimer(el_key);
			__deactivate(el_key);
			__activate(el_key, act);
			__process(el_key, true);
			// Only a momentary press has anything to be promoted TO. A right or
			// middle click already chose the fixed state, and arming the timer
			// over it meant that holding the middle button for half a second
			// quietly turned a lock back into a hold.
			__startHoldTimer(el_key, (act === "pressed"));
		} else {
			let fixed = (__isActive(el_key, "holded") || __isActive(el_key, "locked"));
			if (!state && fixed && __stopHoldTimer(el_key)) {
				return; // Игнорировать первое отжатие сразу после нажатия
			}
			if (!state) {
				__stopHoldTimer(el_key);
				__deactivate(el_key);
				__process(el_key, false);
				if (!fixed) {
					__unholdAll();
				}
			}
		}
	};

	// A finger has no middle or right button, so the two fixed states a mouse
	// reaches with them are reached by tapping a MODIFIER instead: hold, then
	// lock, then off. A modifier is the one kind of key that does nothing
	// pressed on its own, which is what makes latching it the obvious reading
	// of a tap.
	//
	// Nothing else takes part. PrintScreen and the Japanese mode keys carry
	// "hold" rather than "mod" in window-keyboard.pug -- they can be held by a
	// long press, but tapping one has to SEND it -- and neither do the
	// on-screen mouse buttons, where a latched Left is how a finger drags on
	// the host and a tap has to drop it, not lock it down harder.
	//
	// Returns true when the tap was consumed here.
	var __touchLatchHandler = function(el_key) {
		if (!el_key.hasAttribute("data-keypad-modifier") || __isActive(el_key, "locked")) {
			// Clearing a latch lives in exactly one place -- the release path
			// below, which already does it for a mouse.
			return false;
		}
		let held = __isActive(el_key, "holded");
		let down = __isActive(el_key);
		__stopHoldTimer(el_key);
		__deactivate(el_key);
		__activate(el_key, (held ? "locked" : "holded"));
		if (!down) {
			__process(el_key, true);
		}
		// Marks the press, so the release of THIS tap is ignored: the key has
		// just latched and must not be dropped by the finger lifting. The
		// promotion is off -- the state was chosen here, not by a timer.
		__startHoldTimer(el_key, false);
		return true;
	};

	var __startHoldTimer = function(el_key, autohold=true) {
		__stopHoldTimer(el_key);
		let code = el_key.getAttribute("data-keypad-code");
		// "This key will latch in 500ms" used to be drawn by a :hover-gated
		// animation, which a finger can never satisfy -- so on a phone the
		// latch arrived with no warning at all. The state is marked here
		// instead, where it is actually known: the class is on the key exactly
		// while the promotion is armed, so the animation cannot claim a latch
		// that is not coming (a modifier held on a PHYSICAL keyboard reaches
		// emit(), which arms nothing).
		if (autohold && el_key.hasAttribute("data-keypad-allow-autohold")) {
			__setHolding(el_key, true);
		}
		__hold_timers[code] = setTimeout(function() {
			// Помимо прямой функции, hold timer используется для детектирования факта
			// нажатия в рамках одной сессии press/release, чтобы не отпустить сразу же
			// зажатую или заблокированную клавишу. Поэтому таймер инициализируется всегда,
			// но основную функцию выполняет только если у него есть атрибут data-keypad-allow-autohold.
			// autohold is false when a tap has already chosen the state (see
			// __touchLatchHandler); the timer then only marks the press, so
			// the finger lifting does not drop the key it just latched.
			if (autohold && el_key.hasAttribute("data-keypad-allow-autohold")) {
				__deactivate(el_key);
				__activate(el_key, "holded");
			}
		}, 500); // Check keypad.css for the animation
	};

	var __stopHoldTimer = function(el_key) {
		let code = el_key.getAttribute("data-keypad-code");
		if (!__hold_timers[code]) {
			// Nothing armed, so nothing marked: the class is only ever set
			// alongside a timer. __unholdAll() calls this for every key on the
			// board on every keystroke, so it stays a map read.
			return false;
		}
		__setHolding(el_key, false);
		clearTimeout(__hold_timers[code]);
		__hold_timers[code] = null;
		return true;
	};

	var __unholdAll = function() {
		for (let el_key of [].slice.call(__el_keypad.getElementsByClassName("key"))) {
			__stopHoldTimer(el_key);
			if (__isActive(el_key, "holded") && !__isActive(el_key, "locked")) { // Skip duplicating keys
				__deactivate(el_key);
				__process(el_key, false);
			}
		}
	};

	var __isActive = function(el_key, cls=null) {
		let el_keys = __resolveKeys(el_key);
		for (el_key of el_keys) {
			if (cls) {
				if (el_key.classList.contains(cls)) {
					return true;
				}
			} else if (
				el_key.classList.contains("pressed")
				|| el_key.classList.contains("holded")
				|| el_key.classList.contains("locked")
			) {
				return true;
			}
		}
		return false;
	};

	var __activate = function(el_key, cls) {
		let el_keys = __resolveKeys(el_key);
		for (el_key of el_keys) {
			el_key.classList.add(cls);
		}
	};

	var __deactivate = function(el_key) {
		let el_keys = __resolveKeys(el_key);
		for (el_key of el_keys) {
			el_key.classList.remove("pressed");
			el_key.classList.remove("holded");
			el_key.classList.remove("locked");
			el_key.classList.remove("holding");
		}
	};

	// Mirrored across every element carrying the code, exactly like the state
	// classes -- the compact and desktop boards show the same key.
	var __setHolding = function(el_key, on) {
		for (let el of __resolveKeys(el_key)) {
			el.classList.toggle("holding", on);
		}
	};

	var __resolveKeys = function(el_key) {
		let code = el_key.getAttribute("data-keypad-code");
		return __keys[code];
	};

	var __process = function(el_key, state) {
		let code = el_key.getAttribute("data-keypad-code");
		__sendKey(code, state);
	};

	__init__();
}
