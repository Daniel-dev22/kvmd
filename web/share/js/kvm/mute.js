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


import {$} from "../tools.js";


// The "Mute KB/M" switch -- "don't send keyboard & mouse events" -- and the one
// place that reads it.
//
// Every writer has to be covered, not every writer that remembered. The page
// can reach the host by exactly two routes, so the rule is applied at both of
// them rather than at their callers: `sendHidEvent` for the websocket
// (session.js) and `printText` for api/hid/print (print.js). A module that
// sends something next year gets the switch by construction.
//
// 📏 What that is worth, measured on the build before this one: of the three
// modules writing the socket, recorder.js went straight to `sendHidEvent` and
// was not gated at all, so a replayed macro typed, clicked and moved the mouse
// on the host while the switch said it would not. Of the three callers of
// api/hid/print, only the typing bar checked -- the Text panel's Paste and a
// replayed print both typed while muted. The rule was correct and reached a
// third of the traffic.
//
// It silences what the page SENDS; it has never silenced what the page DOES.
// The board clears a latch whether or not the key-up went anywhere -- so a
// release that happens while muted leaves the strip showing nothing held and
// the host still holding it, and from then on the two disagree with no way
// back: `dropHeldKeys()` cannot let go of a key it can no longer see, and the
// next thing typed arrives chorded with nothing on screen to explain it.
//
// So a RELEASE is delivered whatever the switch says. It cannot type anything,
// click anything or move anything -- the only thing it can do is stop one --
// and a mute that can leave a key held down on someone's server is not a mute.
// The cost is that a tap on the board while muted still puts an all-zero HID
// report on the wire; nothing on the host can observe it.
const RELEASABLE = ["key", "mouse_button"];

// Is the switch on? Asked by the two transports to REFUSE, and by the surfaces
// that have to say why nothing happened -- the words belong to each surface,
// the rule belongs here. No null guard: every page that can type renders the
// switch, and a mute that silently fails to mute is the defect above.
export function hidMuted() {
	return $("hid-mute-switch").checked;
}

// Does the switch stop THIS event leaving?
export function hidSilences(ev) {
	if (!hidMuted()) {
		return false;
	}
	return !(RELEASABLE.includes(ev.event_type) && ev.event.state === false);
}
