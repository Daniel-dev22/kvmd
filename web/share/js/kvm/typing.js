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

// The logic behind the compact layout's native typing bar, kept free of the
// DOM and of the transport so it can be tested directly.
//
// The bar is a keystroke PIPE, not a document. Nothing durable accumulates in
// it: every edit is decoded into host commands and the field is put back to
// its padding. There is no feedback channel from the host -- kvmd has only
// video -- so a field that kept a transcript would be claiming to mirror
// something it cannot observe, and would disagree with the console the moment
// anything else touched the host: a strip key, Tab completion, a paste, or the
// host's own output.


// The field is never empty while it has focus.
//
// A soft keyboard decides whether to report a deletion by looking at what is
// in front of the caret: with an empty field Android reports nothing at all,
// so the first Backspace after every reset would vanish -- which is the whole
// bug this padding exists to stop. Zero-width spaces are invisible, take no
// room, and are stripped out of everything on its way to the host.
//
// Eight of them, because a delete gesture can eat a whole run in ONE event and
// the field is only put back on the next task. Nothing depends on the length:
// a deletion that outruns the padding still decodes as a deletion.
export const PAD = "​".repeat(8);

const ZWSP = /​/gu;

// What the user has actually typed, with the padding discarded.
//
// Anything zero-width is structural, never content, so it is removed wherever
// it sits rather than only at the front -- an IME that inserts before the
// caret must not be able to push the padding into the host.
export function stripPad(value) {
	return value.replace(ZWSP, "");
}


// What changed between two states of the typing field.
//
// Everything after the common prefix was removed, and everything after it in
// the new value was typed. That is exact for appending and for erasing at the
// end. An edit made in the MIDDLE is reported as an edit at the end, because
// the host gives us no cursor to reconcile against -- there is no correct
// answer available, only a predictable one.
export function diffTyped(was, now) {
	let same = 0;
	while (same < now.length && same < was.length && now[same] === was[same]) {
		same += 1;
	}
	return {
		"backspaces": (was.length - same),
		"added": now.slice(same),
	};
}


// One edit of the field, decoded into ordered host commands.
//
// Commands are `{"text": "..."}` for characters, which the server maps through
// its keymap, and `{"key": code, "n": count}` for editing intents, which go out
// as ordinary key events. The ORDER is the contract: the queue below is what
// keeps it on the wire.
//
// `input_type` is the InputEvent's own account of what the user meant. It is
// the authority for deletions, because the field's own content cannot answer
// them: after a reset there is nothing but padding in front of the caret, so a
// value diff accounts for nothing while the user has plainly asked to delete
// something. Everything else -- typing, a swipe, dictation, an IME commit, an
// autocorrect replacement -- is exactly what the diff describes.
export function decodeEdit({was, now, input_type = null}) {
	let change = diffTyped(stripPad(was), stripPad(now));
	let out = [];

	if (typeof input_type === "string" && input_type.startsWith("delete")) {
		if (input_type.includes("Forward")) {
			// The caret sits at the end of the field, so a forward delete
			// cannot be accounted for by a prefix diff -- and the diff's
			// backspaces would be a deletion in the WRONG DIRECTION.
			out.push({"key": "Delete", "n": 1});
		} else {
			// Delete as much as can be accounted for, and never nothing.
			//
			// A word- or line-delete gesture is deliberately NOT sent as a
			// chord. Ctrl+Backspace means "delete word" in a GUI field and one
			// character in a shell, so the chord is a guess about an
			// application we cannot see; and pressing Ctrl here would release
			// a modifier the user had latched on the strip. Under-deleting is
			// undone by deleting again. Over-deleting is not.
			out.push({"key": "Backspace", "n": Math.max(change.backspaces, 1)});
		}
	} else if (change.backspaces > 0) {
		out.push({"key": "Backspace", "n": change.backspaces});
	}

	let added = stripPad(change.added);
	if (added.length > 0) {
		out.push({"text": added});
	}
	return out;
}


// Serialises typing onto a request-per-burst transport, in one ORDER.
//
// Characters go to the host over HTTP and keys over the websocket, which are
// two independent transports: a Backspace dispatched the moment it is decoded
// overtakes the characters it was meant to erase, and an Enter overtakes the
// command it was meant to run. Both go through here instead, so a key is never
// dispatched while a print it follows is still in flight.
//
// Sending a request per keystroke is also wasteful, and two overlapping
// requests can reach the host out of order and scramble the text -- so only one
// is ever in flight and anything typed while it runs is coalesced into the next.
export function makeTypingQueue({print, sendKey, getKeymap, onError = null}) {
	let __queue = [];
	let __busy = false;

	let __flush = function() {
		while (!__busy && __queue.length > 0) {
			if (__queue[0].key !== undefined) {
				let cmd = __queue.shift();
				for (let left = cmd.n; left > 0; left -= 1) {
					sendKey(cmd.key, true);
					sendKey(cmd.key, false);
				}
				continue;
			}
			// Everything typed up to the next key goes in one request.
			let text = "";
			while (__queue.length > 0 && __queue[0].text !== undefined) {
				text += __queue.shift().text;
			}
			__busy = true;
			print(text, getKeymap(), function(ok, info) {
				__busy = false;
				if (!ok && onError) {
					onError(info);
				}
				__flush(); // Whatever arrived while that request was running
			});
		}
	};

	return {
		"push": function(cmds) {
			if (cmds.length === 0) {
				return;
			}
			__queue.push(...cmds);
			__flush();
		},
		"isIdle": () => (!__busy && __queue.length === 0),
	};
}
