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

// The single binding point for "a control was pressed" and "a control was
// released", for both mouse and touch. Everything that can be pressed in the UI
// goes through here, so a fix applied here reaches every key, every mouse
// button and every menu item at once.
//
// Deliberately free of DOM lookups: it only assigns handler properties on the
// element it is given. That keeps it unit-testable without a browser.


function __handler(cb, prevent_default) {
	return function(ev) {
		if (prevent_default && ev && ev.preventDefault) {
			ev.preventDefault();
		}
		cb(ev);
	};
}

export function setOnClick(el, cb, prevent_default=true) {
	el.onclick = el.ontouchend = __handler(() => cb(), prevent_default);
}

export function setOnDown(el, cb, prevent_default=true) {
	el.onmousedown = el.ontouchstart = __handler(cb, prevent_default);
}

// A DRAG surface -- press, move, release -- for both a mouse and a finger.
// The callbacks are handed a single {x, y} in client coordinates, so nothing
// downstream has to know which device drew the gesture; the event is passed
// alongside for the rare case that needs the target (a control sitting on top
// of the surface, say).
//
// The drag is latched to the finger that started it, by identifier. Reading
// `touches[0]` instead looks equivalent and is not: a second finger anywhere on
// the screen can take index 0, and the drag then jumps to it and ends wherever
// IT happens to be. A second finger on the surface abandons the drag outright,
// because a pinch is not a selection.
//
// Only the TOUCH defaults are prevented, and that is not a preference: without
// it the browser replays the whole gesture as synthetic mouse events a moment
// later, which starts a second drag and destroys the one just drawn -- and pans
// the page under the finger while it is being drawn. The mouse defaults are
// left alone, because a drag surface still has to take focus when clicked.
//
// onCancel is not optional, for the same reason ontouchcancel is not optional
// below: a gesture the system took away was never finished, and must not be
// treated as though it were.
export function setOnDrag(el, {onStart, onMove, onEnd, onCancel}) {
	let finger = null; // The identifier of the touch drawing right now

	let point = function(ev, touches) {
		if (ev.touches === undefined) {
			return {"x": ev.clientX, "y": ev.clientY}; // A mouse
		}
		for (let touch of touches) {
			if (touch.identifier === finger) {
				return {"x": touch.clientX, "y": touch.clientY};
			}
		}
		return null;
	};

	el.onmousedown = el.ontouchstart = function(ev) {
		if (ev.touches !== undefined) {
			ev.preventDefault();
			if (finger !== null || ev.targetTouches.length > 1) {
				finger = null;
				onCancel();
				return;
			}
			finger = ev.changedTouches[0].identifier;
		}
		let at = point(ev, ev.targetTouches);
		if (at !== null) {
			onStart(at, ev);
		}
	};

	el.onmousemove = el.ontouchmove = function(ev) {
		if (ev.touches !== undefined) {
			ev.preventDefault();
		}
		let at = point(ev, (ev.touches === undefined ? null : ev.targetTouches));
		if (at !== null) {
			onMove(at, ev);
		}
	};

	el.onmouseup = el.ontouchend = function(ev) {
		if (ev.touches !== undefined) {
			ev.preventDefault();
		}
		// On a touchend the finger is gone from `touches` -- it is in
		// `changedTouches`, which is the single most common way a touch port
		// loses the last point of a drag.
		let at = point(ev, (ev.touches === undefined ? null : ev.changedTouches));
		if (at === null) {
			return; // Some other finger lifted; this drag is still going
		}
		finger = null;
		onEnd(at, ev);
	};

	el.ontouchcancel = function(ev) {
		ev.preventDefault();
		finger = null;
		onCancel();
	};
}

export function setOnUp(el, cb, prevent_default=true) {
	// ontouchcancel is not optional. A touch cancelled by a system gesture, an
	// incoming call, or the browser claiming the gesture never produces a
	// touchend -- and without a release the key stays held down on the host we
	// are administering.
	el.onmouseup = el.ontouchend = el.ontouchcancel = __handler(() => cb(), prevent_default);
}
