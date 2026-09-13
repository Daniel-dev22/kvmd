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

export function setOnUp(el, cb, prevent_default=true) {
	// ontouchcancel is not optional. A touch cancelled by a system gesture, an
	// incoming call, or the browser claiming the gesture never produces a
	// touchend -- and without a release the key stays held down on the host we
	// are administering.
	el.onmouseup = el.ontouchend = el.ontouchcancel = __handler(() => cb(), prevent_default);
}
