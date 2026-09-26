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

// Typing text on the host, as opposed to pressing individual keys.
//
// The server owns the keymap: it turns characters into scancodes for whatever
// layout the host is set to. Doing that mapping in the browser would mean a
// second copy of every keymap, so both callers -- the Text menu and the compact
// typing bar -- go through here.


import {tools} from "../tools.js";


// delay is in SECONDS, matching the API. `timeout` is in MILLISECONDS,
// matching tools.httpPost -- and it is the caller's to choose, because the two
// callers are not alike. A paste types a whole document one key at a time and
// may legitimately run for a long while; an interactive keystroke that has not
// landed in seconds is not going to, and holding the queue open for it stalls
// every key behind it.
//
// 📏 The old constant here was `7 * 24 * 3600` -- seconds written into a
// milliseconds parameter, so what was meant as "a week" was 604800 ms, ten
// minutes. Kept as the paste default so that caller is unchanged.
export function printText(text, keymap, delay, on_done, timeout=(7 * 24 * 3600)) {
	tools.httpPost(
		"api/hid/print",
		{"limit": 0, "keymap": keymap, "delay": delay},
		on_done, text, "text/plain", timeout,
	);
}

