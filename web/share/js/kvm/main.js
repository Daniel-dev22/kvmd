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


import {tools, $} from "../tools.js";
import {checkBrowser} from "../bb.js";
import {COMPACT_QUERY, createUiSwitch} from "../ui.js";
import {wm, initWindowManager} from "../wm.js";

import {Session} from "./session.js";


export function main() {
	if (!checkBrowser()) {
		return;
	}

	// base.pug stamped data-ui before first paint; this takes over the same
	// switch so the radio can change the layout live. It used to reload the
	// page here, which dropped the stream, the HID socket and any open form.
	let ui = createUiSwitch({
		"root": document.documentElement,
		"mql": window.matchMedia(COMPACT_QUERY),
		"pref": tools.storage.get("page.ui.type", "auto"),
		"onChange": () => {
			if (wm) { // Not yet built on the first, synchronous resolve
				wm.organizeAllWindows();
			}
		},
	});
	tools.radio.clickValue("page-ui-type-radio", ui.getPref());
	tools.radio.setOnClick("page-ui-type-radio", function() {
		let pref = tools.radio.getValue("page-ui-type-radio");
		tools.storage.set("page.ui.type", pref);
		ui.setPref(pref);
	}, false);

	tools.storage.bindSimpleSwitch($("page-close-ask-switch"), "page.close.ask", true, function(value) {
		if (value) {
			window.onbeforeunload = function(ev) {
				let text = "Are you sure you want to close PiKVM session?";
				if (ev) {
					ev.returnValue = text;
				}
				return text;
			};
		} else {
			window.onbeforeunload = null;
		}
	});

	initWindowManager();

	tools.el.setOnClick($("open-log-button"), () => tools.windowOpen("api/log?seek=3600&follow=1"));

	tools.storage.bindSimpleSwitch(
		$("page-full-tab-stream-switch"),
		"page.full_tab_stream",
		tools.config.getBool("kvm--full-tab-stream", false));
	if ($("page-full-tab-stream-switch").checked) {
		wm.setFullTabWindow($("stream-window"), true);
	}

	wm.showWindow($("stream-window"));
	// The mouse pad used to be opened here on every phone load. Together with
	// the keyboard sheet and the system keyboard it left no video at all, and
	// most of the time it is not what the session is for. It is one tap away
	// from the Keyboard window's header and from System -> Mouse.

	new Session();
}
