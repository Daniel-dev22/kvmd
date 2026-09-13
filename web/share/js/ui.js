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

// Which layout the page is in is ONE attribute on <html>: data-ui="desktop" or
// data-ui="mobile". Every compact rule in the stylesheets keys off it, so the
// breakpoint itself is written down exactly once -- here -- instead of being
// repeated in every media query.
//
// This module is pure. It never reads the DOM, the user agent or the URL, which
// is what lets the interface style change live: there is nothing here that
// could reload the page.


export const UI_AUTO = "auto";
export const UI_DESKTOP = "desktop";
export const UI_MOBILE = "mobile";

// 64rem is the point below which the desktop's floating windows and wide menus
// stop fitting. `pointer: coarse` catches a touch device that is wider than
// that -- a tablet gets touch sizing without being forced into a phone layout.
export const COMPACT_QUERY = "(max-width: 63.999rem), (pointer: coarse)";

// Whether the device can hover at all. Separate from the layout: a laptop
// with a touchscreen has both, and a tablet in a keyboard case has neither
// the phone layout nor a pointer that can hover.
export const HOVER_QUERY = "(hover: hover)";

export function normalizePref(value) {
	return ((value === UI_DESKTOP || value === UI_MOBILE) ? value : UI_AUTO);
}

export function resolveUi(pref, compact) {
	let norm = normalizePref(pref);
	if (norm !== UI_AUTO) {
		return norm;
	}
	return (compact ? UI_MOBILE : UI_DESKTOP);
}

// root: the element to stamp (document.documentElement in the page).
// mql:  a MediaQueryList for COMPACT_QUERY.
// pref: the stored user preference, one of auto/desktop/mobile.
export function createUiSwitch({root, mql, pref, onChange=null}) {
	let __pref = normalizePref(pref);

	let __apply = function() {
		let mode = resolveUi(__pref, mql.matches);
		root.setAttribute("data-ui", mode);
		if (onChange) {
			onChange(mode);
		}
		return mode;
	};

	// Rotating, resizing, or docking a window re-resolves the layout while the
	// preference is auto. An explicit choice is never overridden.
	mql.addEventListener("change", __apply);
	__apply();

	return {
		"getPref": () => __pref,
		"current": () => resolveUi(__pref, mql.matches),
		"setPref": function(value) {
			__pref = normalizePref(value);
			return __apply();
		},
	};
}
