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
// second copy of every keymap, so all three callers -- the Text menu, the
// compact typing bar and a replayed recording -- go through here.
//
// And because they all do, this is also the one place that can put the
// on-screen board down first. See below.


import {tools} from "../tools.js";


// Milliseconds. Long enough for kvmd to have read a websocket frame written
// just before it, short enough that nobody feels it, and paid ONCE per burst
// rather than per character.
const HANDOVER_MS = 10;


// The keyboard, as far as typing text is concerned: what the on-screen board
// is holding, and whether the HID will do anything with what it is sent.
//
// Registered once by the Keyboard, which owns both -- and which cannot be
// imported from here, because it imports this.
let __kbd = null;

export function setKeyboardState(kbd) {
	__kbd = kbd;
}

function __keyboard() {
	if (__kbd === null) {
		// Not a fallback: a page that types with no keyboard wired to it is a
		// wiring bug, and carrying on would ship the corruption described
		// below. Every page that can print builds a Keyboard before it can.
		throw new Error("print: no keyboard is registered -- see setKeyboardState()");
	}
	return __kbd;
}

// Why a keystroke sent right now might not reach the host -- in the same words
// the keyboard LED uses -- or null when nothing says it would not.
//
// Not a precondition for typing: see the 🔴 note in keyboard.js. It is the
// answer a caller needs to avoid claiming that it arrived.
export function hidNotReadyReason() {
	return __keyboard().notReady();
}


// Everything under here is typed by the SERVER, one scancode at a time, into
// whatever modifier state the HID is already in -- and a modifier latched on
// the board is a key genuinely held DOWN on the host. So typing `ls` with Ctrl
// latched does not type `ls`: the host gets Ctrl+L, which clears the screen,
// and Ctrl+S, which freezes the terminal until Ctrl+Q. Nothing on screen says
// why, because the bar shows what was TYPED, not what was sent.
//
// It is not a chord the user could have meant, either. printer.py presses
// Shift and AltGr itself for any character that needs them, so a latched Ctrl
// over a capital C is Ctrl+Shift+C -- copy, not interrupt -- and over `@` on a
// German keymap it is Ctrl+AltGr+Q. A chord is built from key CODES; a
// character plus a held modifier is only a chord by accident, and only for
// unshifted ASCII on a keymap that happens to match.
//
// So the board is let go first, every time. The alternative -- refusing to
// type while something is latched -- was rejected: it drops what the user
// typed to protect a chord they cannot reliably get anyway, and it needs a
// second explanation on screen for a state the strip is already showing. The
// key visibly un-latching IS the feedback, and the chords that ARE well formed
// (Ctrl with the strip's own arrows, Esc, Tab) go through the keypad and are
// untouched by this.
//
// delay is in SECONDS, matching the API. `timeout` is in MILLISECONDS,
// matching tools.httpPost -- and it is the caller's to choose, because the
// callers are not alike. A paste types a whole document one key at a time and
// may legitimately run for a long while; an interactive keystroke that has not
// landed in seconds is not going to, and holding the queue open for it stalls
// every key behind it.
//
// 📏 The old constant here was `7 * 24 * 3600` -- seconds written into a
// milliseconds parameter, so what was meant as "a week" was 604800 ms, ten
// minutes. Kept as the paste default so that caller is unchanged.
//
// `keymap`, `delay` and `opts.slow` are omitted from the request when null,
// which is how a replayed recording asks for the server's own defaults.
export function printText(text, keymap, delay, on_done, opts={}) {
	let {timeout = (7 * 24 * 3600), slow = null} = opts;
	let released = __keyboard().dropHeldKeys();
	let params = {"limit": 0};
	if (keymap !== null) {
		params["keymap"] = keymap;
	}
	if (delay !== null) {
		params["delay"] = delay;
	}
	if (slow !== null) {
		params["slow"] = slow;
	}
	let post = () => tools.httpPost("api/hid/print", params, on_done, text, "text/plain", timeout);
	if (released > 0) {
		// The release left on the websocket and this request goes out on a
		// second connection; nothing orders one against the other, because
		// kvmd handles them as independent tasks. The release is written first
		// and is microseconds ahead, which is not a guarantee -- and losing
		// that race does not chord one character, it chords the WHOLE burst:
		// `send_key_events` only yields between keys when a delay was asked
		// for (kvmd/plugins/hid/__init__.py:151-155), so with the bar's
		// delay=0 the entire text goes into the HID queue in one go.
		//
		// So the request is not even ISSUED until the frame has had a head
		// start. Done here rather than by asking the server for a per-key
		// delay, which would have cost 10ms per CHARACTER -- fifty seconds on
		// a five-thousand-character paste.
		setTimeout(post, HANDOVER_MS);
	} else {
		post();
	}
}
