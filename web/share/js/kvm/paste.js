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
import {wm} from "../wm.js";
import {printText, hidNotReadyReason} from "./print.js";
import {hidMuted} from "./mute.js";


export function Paste(__recorder) {
	var self = this;

	/************************************************************************/

	var __init__ = function() {
		$("hid-pak-text").addEventListener("keyup", function(ev) {
			if (ev.ctrlKey && ev.code == "Enter") {
				wm.click($("hid-pak-button"));
			}
		});

		tools.storage.bindSimpleSwitch($("hid-pak-ask-switch"), "hid.pak.ask", true);

		tools.storage.bindSimpleSwitch($("hid-pak-secure-switch"), "hid.pak.secure", false, function(value) {
			// One attribute, one preference, every field that types on the host --
			// see main.css. It was an inline style on this one box, which is why
			// the compact layout's typing bar, the field a phone actually types
			// passwords into, showed them in 16px while the switch said they were
			// hidden. The switch is the Text menu's to own (it is rendered there);
			// what it COVERS is a stylesheet's, so a third field cannot need a
			// second copy of this callback.
			document.documentElement.toggleAttribute("data-hid-secure", value);
		});

		tools.storage.bindSimpleSlider($("hid-pak-delay-slider"), "hid.pak.delay", 0, 200, 20, 20, function (value) {
			$("hid-pak-delay-value").innerText = value + " ms";
		});

		$("hid-pak-keymap-selector").addEventListener("change", function() {
			tools.storage.set("hid.pak.keymap", $("hid-pak-keymap-selector").value);
		});

		tools.el.setOnClick($("hid-pak-button"), __clickPasteAsKeysButton);
	};

	/************************************************************************/

	self.setState = function(state) {
		tools.el.setEnabled($("hid-pak-text"), state);
		tools.el.setEnabled($("hid-pak-button"), state);
		if (state) {
			let el = $("hid-pak-keymap-selector");
			let sel = tools.storage.get("hid.pak.keymap", state.keymaps["default"]);
			el.options.length = 0;
			for (let keymap of state.keymaps.available) {
				tools.selector.addOption(el, keymap, keymap, (keymap === sel));
			}
		}
	};

	var __clickPasteAsKeysButton = function() {
		let text = $("hid-pak-text").value;
		if (text) {
			let paste_as_keys = function() {
				tools.el.setEnabled($("hid-pak-text"), false);
				tools.el.setEnabled($("hid-pak-button"), false);
				tools.el.setEnabled($("hid-pak-keymap-selector"), false);

				let keymap = $("hid-pak-keymap-selector").value;
				let delay = $("hid-pak-delay-slider").valueAsNumber;

				// The length, never the body: this is where people paste
				// passwords -- the panel ships a switch that hides them on
				// screen -- and ?debug=1 is one link away. The bar's own path
				// has never logged it.
				tools.debug(`HID: paste-as-keys ${keymap}: ${text.length} characters`);

				printText(text, keymap, delay / 1000, function(http) {
					tools.el.setEnabled($("hid-pak-text"), true);
					tools.el.setEnabled($("hid-pak-button"), true);
					tools.el.setEnabled($("hid-pak-keymap-selector"), true);
					if (http === null) {
						// print.js refused on "Mute KB/M" and sent nothing. Said
						// here rather than left silent: the switch is two menus
						// away in System, and a Paste that visibly does nothing is
						// indistinguishable from a PiKVM that has stopped
						// answering. The text STAYS in the box -- it was never
						// typed, and clearing it would throw away the only copy.
						wm.info(
							"Nothing was pasted: <b>Mute KB/M</b> is on, so the page is not"
							+ " sending keyboard or mouse events.<br><br>Your text is still in the box.",
						);
						return;
					}
					$("hid-pak-text").value = "";
					if (http.status === 413) {
						wm.error("Too many text for paste!");
					} else if (http.status !== 200) {
						wm.error("Keyboard paste error", http.responseText);
					} else if (http.status === 200) {
						__recorder.recordPrintEvent(text, keymap, delay);
					}
				});
			};

			// Muted, there is nothing to be sure about: printText will refuse
			// and the callback above says so, which is one dialog instead of
			// "are you sure?" followed by "it did not happen". This decides
			// only whether to ASK -- deleting it puts the pointless question
			// back and changes nothing about what leaves the page, which is
			// print.js's to refuse and not paste.js's to remember.
			if ($("hid-pak-ask-switch").checked && !hidMuted()) {
				// api/hid/print answers 200 whether or not kvmd could deliver a
				// single scancode, so a paste into an unenumerated gadget looks
				// exactly like one that worked. Said here rather than invented
				// as a new surface: the confirmation is already the moment the
				// user is deciding whether to do it.
				let why = hidNotReadyReason();
				let doubt = (why === null ? "" : `
					<br><br>${tools.escape(why)}: this may not arrive.
				`);
				wm.confirm(`
					You're going to paste ${text.length} character${text.length ? "s" : ""}.<br>
					Are you sure you want to continue?${doubt}
				`).then(function(ok) {
					if (ok) {
						paste_as_keys();
					} else {
						$("hid-pak-text").value = "";
					}
				});
			} else {
				paste_as_keys();
			}
		}
	};

	__init__();
}
