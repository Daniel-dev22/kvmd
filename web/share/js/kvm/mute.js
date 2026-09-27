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


// The "Mute KB/M" switch, as both transports have to read it.
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

export function hidSilences(ev) {
	if (!$("hid-mute-switch").checked) {
		return false;
	}
	return !(RELEASABLE.includes(ev.event_type) && ev.event.state === false);
}
