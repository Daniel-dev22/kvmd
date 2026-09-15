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

// ttyd merges the URL query over its own options AND the server's, and a key it
// does not recognise falls through to xterm's own options -- so this is how the
// terminal's font size is set from out here, with no ttyd flag and no reload
// (ttyd 1.7.7, html/src/components/terminal/xterm/index.ts:
// parseOptsFromUrlQuery, spread LAST into applyPreferences; the default branch
// assigns terminal.options[key]. src/protocol.c sends SET_PREFERENCES on every
// connect, so that path always runs).

"use strict";


// What a phone terminal is FOR: a prompt, a command, the first screen of its
// output. 30 columns fits `systemctl status foo` without wrapping it twice, and
// is the width the size is derived from rather than a font size picked by eye.
export const WEBTERM_COLUMNS = 30;

// xterm's own default is 15px -- 43 columns on a 390px phone, and too small to
// read at arm's length. The floor is what makes the change visible at all; the
// ceiling stops a tablet from getting a font meant for a watch.
export const WEBTERM_FONT_MIN_PX = 18;
export const WEBTERM_FONT_MAX_PX = 26;

// The advance width of a monospace glyph, in em. DejaVu Sans Mono -- what these
// browsers fall back to -- is 0.602; every common terminal face is near enough
// that a column count derived from it is out by less than one column.
const CHAR_ASPECT = 0.6;


export function webtermFontSize(width_px) {
	let size = Math.round(width_px / (WEBTERM_COLUMNS * CHAR_ASPECT));
	return Math.min(Math.max(size, WEBTERM_FONT_MIN_PX), WEBTERM_FONT_MAX_PX);
}


// width_px is the width the terminal has to live in, or null for a desktop,
// which keeps the terminal's own default.
export function webtermUrl(base, path, width_px) {
	// The trailing slash avoids an Nginx 301 when the location has none, which
	// a reverse proxy in front of PiKVM can be misconfigured to mishandle.
	let url = base + path + "/?disableLeaveAlert=true";
	return (width_px === null ? url : `${url}&fontSize=${webtermFontSize(width_px)}`);
}
