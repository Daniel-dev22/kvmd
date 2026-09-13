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


// Serialises interactive typing onto a request-per-burst transport.
//
// Characters arrive one keystroke at a time. Sending a request each is wasteful
// and, worse, two overlapping requests can reach the host out of order and
// scramble the text -- so only one is ever in flight and anything typed while
// it runs is coalesced into the next one.
export function makePrintQueue({post, getKeymap, onError = null}) {
	let __pending = "";
	let __busy = false;

	let __flush = function() {
		if (__busy || __pending.length === 0) {
			return;
		}
		let text = __pending;
		__pending = "";
		__busy = true;
		post(text, getKeymap(), function(ok, info) {
			__busy = false;
			if (!ok && onError) {
				onError(info);
			}
			__flush(); // Whatever was typed while that request was running
		});
	};

	return {
		"push": function(text) {
			if (text.length > 0) {
				__pending += text;
				__flush();
			}
		},
		"isIdle": () => (!__busy && __pending.length === 0),
	};
}
