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


import {tools, $, $$$} from "../tools.js";
import {Keypad} from "../keypad.js";
import {wm} from "../wm.js";
import {UI_MOBILE} from "../ui.js";
import {hidMuted} from "./mute.js";
import {printText, setKeyboardState} from "./print.js";
import {PAD, decodeEdit, makeTypingQueue} from "./typing.js";


// An interactive keystroke that has not landed in fifteen seconds is not going
// to, and every key behind it in the queue is waiting on it.
const TYPING_TIMEOUT_MS = 15000;

// Long enough to READ. The old signal was a 2s border, and a border does not
// have to be read.
const PROBLEM_SHOWN_MS = 4000;

// Named once because two paths say it -- a burst of text and a lone Enter fail
// in different places and must not word the same state differently. "nothing
// was sent" rather than "may not have arrived": the mute switch is a fact the
// page can check, not an inference about the far end.
const MUTED_SAID = "Muted \u2014 nothing was sent";


export function Keyboard(__recordWsEvent, __recordPrintEvent) {
	var self = this;

	/************************************************************************/

	var __ws = null;
	// true / false / null are kvmd's three answers -- ready, inactive or busy,
	// and the whole emulator gone. `undefined` is the fourth state the page has
	// always been in and never had a name for: NOT TOLD YET. It used to start
	// as `true`, which is a claim about a HID nothing had spoken to.
	var __online = undefined;

	var __caps_led = false;

	var __keypad = null;
	var __el_magic = null;

	var __init__ = function() {
		// Built on the whole window, so it binds BOTH arrangements. Keypad
		// resolves a code to every element carrying it, which is what keeps
		// modifier state in step between the desktop and compact boards.
		__keypad = new Keypad($("keyboard-window"), __sendKey);
		// Anything that types TEXT on the host does it through print.js, which
		// puts the board down first: a modifier latched on the strip is a key
		// held down on the HID, and every character the server types under it
		// arrives as a chord. print.js carries the whole reasoning, and asks
		// the same two questions of the same keyboard the bar does.
		setKeyboardState({
			"dropHeldKeys": self.releaseAll,
			"notReady": () => (__hidReady() ? null : __whyNotReady()),
		});

		__initLayers();
		__initTyping();

		$("hid-keyboard-led").title = "Keyboard free";

		for (let el of [$("keyboard-window"), $("mouse-window"), $("stream-window")]) {
			el.onkeydown = (ev) => __keyboardHandler(ev, true);
			el.onkeyup = (ev) => __keyboardHandler(ev, false);
			el.addEventListener("focus", __updateOnlineLeds);
			el.addEventListener("blur", __updateOnlineLeds);
		}

		window.addEventListener("focusin", __updateOnlineLeds);
		window.addEventListener("focusout", __updateOnlineLeds);

		for (let what of ["mouseenter", "mouseleave", "mousemove"]) {
			window.addEventListener(what, __syncCapsOnMouse);
		}

		tools.storage.bindSimpleSwitch($("hid-keyboard-bad-link-switch"), "hid.keyboard.bad_link", false);
		tools.storage.bindSimpleSwitch($("hid-keyboard-swap-cc-switch"), "hid.keyboard.swap_cc", false);
		tools.storage.bindSimpleSwitch($("hid-keyboard-sync-caps-switch"), "hid.keyboard.sync_caps", false);

		__el_magic = $("hid-keyboard-magic-selector");
		let alt = (tools.browser.is_apple ? "Option" : "Alt");
		let meta = (tools.browser.is_win ? "Win" : "Meta");
		let sel = tools.storage.get("hid.keyboard.magic", (tools.browser.is_apple ? "AltRight" : "ControlRight"));
		for (let kv of [
			["Ctrl Left", "ControlLeft"],
			[`${alt} Left`, "AltLeft"],
			["Shift Left", "ShiftLeft"],
			[`${meta} Left`, "MetaLeft"],
			null,
			["Ctrl Right", "ControlRight"],
			[`${alt} Right`, "AltRight"],
			["Shift Right", "ShiftRight"],
			[`${meta} Right`, "MetaRight"],
			null,
			["Menu Key", "ContextMenu"],
			null,
			["\u2500 None \u2500", ""],
		]) {
			if (kv === null) {
				tools.selector.addSeparator(__el_magic, 8);
			} else {
				if ((tools.browser.is_apple || tools.browser.is_win) && kv[1].startsWith("Meta")) {
					continue;
				}
				tools.selector.addOption(__el_magic, kv[0], kv[1], (kv[1] === sel));
			}
		}
		__el_magic.addEventListener("change", function() {
			tools.storage.set("hid.keyboard.magic", __el_magic.value);
		});
	};

	/************************************************************************/

	self.setSocket = function(ws) {
		if (ws !== __ws) {
			self.releaseAll();
			__ws = ws;
			// Nothing is known about THIS session's HID until it says so, and
			// the last one's answer is not an answer: kvmd sends the whole
			// state the moment the socket opens, so this is unknown for about
			// a round trip. Carrying the old value across a reconnect is how a
			// gadget that went offline while we were away reads as ready --
			// and `null` would be the opposite lie, a red LED and an "emulator
			// offline" on a PiKVM that is perfectly well.
			__online = undefined;
		}
		__updateOnlineLeds();
	};

	self.setState = function(online, leds, hid_online, hid_busy) {
		if (!hid_online) {
			__online = null;
		} else {
			__online = (online && !hid_busy);
		}
		__updateOnlineLeds();

		__caps_led = leds["caps"];
		for (let led of ["caps", "scroll", "num"]) {
			for (let el of $$$(`.hid-keyboard-${led}-led`)) {
				if (leds[led]) {
					el.classList.add("led-green");
					el.classList.remove("led-gray");
				} else {
					el.classList.add("led-gray");
					el.classList.remove("led-green");
				}
			}
		}
	};

	// Everything the page is holding down on the host, let go.
	//
	// The magic-shortcut composer is the other thing that holds keys: while it
	// is armed it deliberately SWALLOWS modifier releases (see __sendKey), so
	// that letting go of Ctrl on a real keyboard does not let go of it on the
	// host. Clearing the board alone therefore un-latches the key on screen and
	// leaves it held on the host -- with `isCodeActive` now false, no later
	// release can ever emit it either. Its own release path bypasses __sendKey,
	// so it is the one that has to run.
	self.releaseAll = function() {
		let released = 0;
		if (__magic_started || __magic_mods.length > 0) {
			released += __magic_mods.length;
			__releaseMagicModifiers();
		}
		return (released + __keypad.releaseAll());
	};

	self.emit = function(code, state) {
		__keypad.emit(code, state);
	};

	var __updateOnlineLeds = function() {
		let is_captured = (
			$("stream-window").classList.contains("window-active")
			|| $("keyboard-window").classList.contains("window-active")
			|| $("mouse-window").classList.contains("window-active")
		);
		let led = "led-gray";
		let title = "Keyboard free";

		if (__ws) {
			if (__online === undefined) {
				// Connected, and not told anything yet -- about a round trip.
				// Either answer painted here would be a guess, and this one is
				// re-rendered the moment the first state event lands.
				title = (is_captured ? "Keyboard captured, connecting" : "Keyboard free, connecting");
			} else if (__online === null) {
				led = "led-red";
				title = (is_captured ? "Keyboard captured, emulator offline" : "Keyboard free, emulator offline");
			} else if (__online) {
				if (is_captured) {
					led = "led-green";
					title = "Keyboard captured";
				}
			} else {
				led = "led-yellow";
				title = (is_captured ? "Keyboard captured, inactive/busy" : "Keyboard free, inactive/busy");
			}
		} else {
			if (is_captured) {
				title = "Keyboard captured, PiKVM offline";
			}
		}
		$("hid-keyboard-led").className = led;
		$("hid-keyboard-led").title = title;
	};

	/************************************************************************/

	var __sync_caps_armed = true;

	var __syncCapsReload = function() {
		__sync_caps_armed = false;
		setTimeout(function() { __sync_caps_armed = true; }, 1500);
	};

	var __isSyncCapsActivated = function(ev) {
		if (__online && __sync_caps_armed) {
			let caps = ev.getModifierState("CapsLock");
			if (caps !== __caps_led && $("hid-keyboard-sync-caps-switch").checked) {
				tools.info("Synchronizing CapsLock:", __caps_led, "->", caps);
				__syncCapsReload();
				return true;
			}
		}
		return false;
	};

	var __syncCapsOnMouse = function(ev) {
		if (__isSyncCapsActivated(ev)) {
			__innerSendKey("CapsLock", true);
			setTimeout(function() {
				__innerSendKey("CapsLock", false);
			}, 100);
		}
	};

	// The typing bar owns the line being typed, so the scancode path must keep
	// its hands off the keys that edit it.
	//
	// This handler is bound on the whole keyboard WINDOW, and the bar lives
	// inside it -- so every key pressed in the bar was also going out as a
	// scancode the instant it was pressed. Enter reached the host TWICE, and the
	// immediate one arrived ahead of the characters it was meant to run; every
	// other key was preventDefault()ed before it could enter the field at all,
	// which is why a hardware keyboard could not type into the bar.
	//
	// A character, Backspace, Delete and Enter are part of the line and go
	// through the bar's queue. Everything else -- Esc, Tab, the arrows, anything
	// held with Ctrl/Alt/Meta -- is not, and still goes straight out, because
	// Ctrl+C in a console is not optional.
	// Which presses the bar swallowed, so their RELEASES are swallowed too.
	//
	// Focus can move between a keydown and its keyup -- press a key over the
	// stream, then tap the bar, then let go -- and classifying each event by
	// where it happens to land would send the press and eat the release, leaving
	// that key held down on the host forever. The press decides; the release
	// follows its own press.
	var __bar_keys = new Set();

	var __isTypingBarKey = function(ev, state) {
		if (!state) {
			return __bar_keys.delete(ev.code);
		}
		// AltGr is Ctrl+Alt on Windows and Linux, so testing those two flags
		// alone refuses every AltGr character -- @ \\ [ ] { } ~ on a German,
		// French or Nordic layout -- and sends it as a raw scancode for the
		// HOST's layout to reinterpret, which is the second keymap the print
		// path exists to avoid.
		let altgr = (typeof ev.getModifierState === "function" && ev.getModifierState("AltGraph"));
		let chord = (!altgr && (ev.ctrlKey || ev.altKey)) || ev.metaKey;
		let mine = (
			ev.target === $("hid-type-input")
			&& typeof ev.key === "string"
			&& !chord
			// "Process" and "Unidentified" are a soft keyboard mid-composition:
			// the field is the only thing that can say what the user meant.
			//
			// Delete is NOT here: the caret is pinned at the end of the field, so
			// a forward delete changes nothing and fires no input event -- the bar
			// would claim it and then never see it, and it reached the host by
			// neither path.
			&& (ev.key.length === 1
				|| ["Enter", "Backspace", "Process", "Unidentified"].includes(ev.key))
		);
		if (mine) {
			__bar_keys.add(ev.code);
		} else {
			__bar_keys.delete(ev.code);
		}
		return mine;
	};

	var __keyboardHandler = function(ev, state) {
		if (__isTypingBarKey(ev, state)) {
			return;
		}
		if (ev.code === "CapsLock") {
			__syncCapsReload();
		}
		if (__isSyncCapsActivated(ev)) {
			__innerSendKey("CapsLock", true);
			setTimeout(function() {
				__innerSendKey("CapsLock", false);
				setTimeout(() => __innerKeyboardHandler(ev, state), 100);
			}, 100);
		} else {
			__innerKeyboardHandler(ev, state);
		}
	};

	var __altgr_ctrl_timer = null;

	var __innerKeyboardHandler = function(ev, state) {
		ev.preventDefault();
		if (ev.repeat) {
			return;
		}
		let code = ev.code;

		// https://github.com/pikvm/pikvm/issues/819
		if (code === "IntlBackslash" && ["`", "~"].includes(ev.key)) {
			code = "Backquote";
		} else if (code === "Backquote" && ["§", "±"].includes(ev.key)) {
			code = "IntlBackslash";
		}

		// Mac CMD key fix
		if (tools.browser.is_mac) {
			if (!__magic_pressed && !state && ["MetaLeft", "MetaRight"].includes(code)) {
				self.releaseAll();
			}
		}

		// https://github.com/pikvm/pikvm/issues/375
		// https://github.com/novnc/noVNC/blob/84f102d6/core/input/keyboard.js
		if (tools.browser.is_win) {
			if (state) {
				if (__altgr_ctrl_timer) {
					// Если у нас было отложенное нажатие Ctrl, и новая клавиша не Alt,
					// то выстреливаем Ctrl немедленно.
					clearTimeout(__altgr_ctrl_timer);
					__altgr_ctrl_timer = null;
					if (code !== "AltRight") {
						__keypad.emit("ControlLeft", true);
					}
				}
				if (code === "ControlLeft" && !__keypad.isCodeActive("ControlLeft")) {
					// Если пришел новый Ctrl, откладываем его нажатие на 50ms...
					__altgr_ctrl_timer = setTimeout(function() {
						__altgr_ctrl_timer = null;
						__keypad.emit("ControlLeft", true);
					}, 50);
					return; // ... и больше не делаем вообще ничего
				}
			} else {
				if (__altgr_ctrl_timer) {
					// Если Ctrl был отложен, но что-то отпустили,
					// то выстреливаем Ctrl немедленно.
					clearTimeout(__altgr_ctrl_timer);
					__altgr_ctrl_timer = null;
					__keypad.emit("ControlLeft", true);
				}
			}
		}

		__keypad.emit(code, state);
	};

	var __magic_pressed = false;
	var __magic_pressed_ts = 0;
	var __magic_started = false;
	var __magic_fired_once = false;
	var __magic_mods = [];
	var __all_mods = {
		"ControlLeft": "Ctrl L",
		"ControlRight": "Ctrl R",
		"AltLeft": (tools.browser.is_apple ? "Option L" : "Alt L"),
		"AltRight": (tools.browser.is_apple ? "Option R" : "Alt R"),
		"ShiftLeft": "Shift L",
		"ShiftRight": "Shift R",
		"MetaLeft": (tools.browser.is_apple ? "Cmd L" : "Meta L"),
		"MetaRight": (tools.browser.is_apple ? "Cmd R" : "Meta R"),
	};

	var __isModifier = function(code) {
		return (code in __all_mods);
	};

	var __startMagic = function() {
		__magic_started = true;
		__drawMagicOverStream();
	};

	var __addNewMagicModifier = function(code) {
		if (!__magic_mods.includes(code)) {
			__magic_mods.push(code);
			__drawMagicOverStream();
			return true;
		}
		return false;
	};

	var __drawMagicOverStream = function(code=null) {
		let html = "";
		if (__magic_started) {
			html += "<span>Shortcut &rarr;</span>";
		}
		for (let mod of __magic_mods) {
			html += `<span>${__all_mods[mod]}</span>`;
		}
		if (code) {
			html += `<span>${code}</span>`;
		}
		$("stream-keyboard-magic").innerHTML = html;
	};

	var __releaseMagicModifiers = function() {
		while (__magic_mods.length > 0) {
			__innerSendKey(__magic_mods.pop(), false, false);
		}
		__magic_started = false;
		__magic_fired_once = false;
		__magic_mods = [];
		setTimeout(function() {
			if (!__magic_started) {
				__drawMagicOverStream();
			}
		}, 100);
	};

	var __sendKey = function(code, state) {
		if ($("hid-keyboard-swap-cc-switch").checked) {
			if (code === "ControlLeft") {
				code = "CapsLock";
			} else if (code === "CapsLock") {
				code = "ControlLeft";
			}
		}
		if (code === __el_magic.value) {
			let now_ts = new Date().getTime();
			__magic_pressed = state;
			if (state) {
				if (__magic_started) {
					if (now_ts - __magic_pressed_ts < 250) {
						__releaseMagicModifiers();
					}
				} else {
					__startMagic();
				}
			} else if (__magic_fired_once) {
				__releaseMagicModifiers();
			}
			__magic_pressed_ts = now_ts;
		} else {
			if (__magic_started) {
				if (__isModifier(code)) {
					if (state && __addNewMagicModifier(code)) {
						__innerSendKey(code, state, false);
					}
				} else {
					__drawMagicOverStream(state ? code : null);
					__innerSendKey(code, state, false);
					__magic_fired_once = true;
					if (!__magic_pressed) {
						__releaseMagicModifiers();
					}
				}
			} else {
				__innerSendKey(code, state, true);
			}
		}
	};

	// ======================= native typing =======================
	//
	// The phone's own keyboard drives the host. Characters go through the
	// server's keymap (api/hid/print) rather than being mapped to scancodes
	// here, so swipe, dictation, long-press accents and autocorrect all work,
	// and there is no second copy of every keymap in the browser. Editing
	// intents that are not characters -- Backspace, Enter -- go out as ordinary
	// key events, through the SAME queue, so they cannot overtake the text they
	// follow.
	//
	// The field is a pipe, never a transcript: see typing.js. It holds the word
	// an IME is still composing and nothing else, because everything before that
	// has already reached the host.

	var __typed = "";
	var __composing = false;
	var __queue = null;
	var __reset_timer = null;
	var __failed_timer = null;
	var __exitTyping = null;
	var __blur_timer = null;

	// Can a keystroke leave at all?
	//
	// One direction of it is a FACT: with no socket, or one the engine has
	// already closed, __innerSendKey sends nothing, so the key is definitely
	// lost -- and a key lost while the text around it still goes out over HTTP
	// is not a dropped keystroke but a corrupted line, which is `helo` plus a
	// correction arriving as `helolo`. Typing stops until the session's own
	// reconnect loop (session.js, every ~1s) hands back a socket; that path
	// does not run through here.
	//
	// ⚠ The other direction is NOT a fact and cannot be made one from the
	// browser. A half-open socket -- the far side gone, no FIN, which is what a
	// phone changing networks produces -- still reads OPEN and still accepts
	// send() silently. session.js's heartbeat bounds that at 15 missed pings,
	// so the window is up to ~15s wide, and inside it this answers "up" and the
	// keys go nowhere. Closing it properly needs an ack per event, which the
	// protocol does not have.
	var __linkUp = () => (__ws !== null && __ws.readyState === WebSocket.OPEN);

	// Will the HID do anything with it if it does?
	//
	// An INFERENCE, from kvmd's own state stream: `keyboard.online` is false
	// when the OTG gadget is not enumerated and `busy` is true during a reset,
	// and in both cases kvmd accepts the report and discards it -- api/hid/print
	// answers 200 either way, which is the whole reason the bar could claim
	// success for a keystroke that never happened.
	//
	// 🔴 This deliberately does NOT stop the typing. If the inference is wrong
	// -- a plugin whose `online` means something else, a state stream that has
	// not caught up -- refusing would leave a user unable to type at all, with
	// no way round it, to prevent a message being optimistic. Sending under a
	// wrong inference costs nothing: kvmd discards it exactly as it would have.
	// So it is REPORTED, not enforced.
	var __hidReady = () => (__online === true);

	// Why it will not, in the LED's own vocabulary: the page must not tell the
	// user the emulator is offline while the LED beside it says busy.
	var __whyNotReady = function() {
		if (__online === null) {
			return "Emulator offline"; // The red LED
		}
		if (__online === false) {
			return "Keyboard inactive/busy"; // The yellow one
		}
		return "Still connecting"; // Not told yet -- see setSocket()
	};

	// What happened to the keystrokes, in WORDS.
	//
	// A 2s red border was the whole signal before this: colour only, nothing
	// for a screen reader, and nothing that says which of three things went
	// wrong. It matters more here than on a desktop -- the queue drops whatever
	// was behind a failure, the video is the only other evidence, and with the
	// navbar collapsed into its button the keyboard LED is not even on screen.
	// `urgent` means something was DROPPED, and always takes the line. A
	// warning does not: it is true for as long as the state lasts and is asked
	// on every key event, so letting it re-arm the timer would pin the line up
	// for the whole burst, and letting it replace a failure would take a status
	// code off the screen before it could be read.
	var __sayTyping = function(text, urgent=false) {
		let el = $("hid-type-input");
		let el_status = $("hid-type-status");
		if (el === null || el_status === null) {
			return; // Desktop pages do not render the typing bar
		}
		if (!urgent && __failed_timer !== null) {
			return;
		}
		el.setAttribute("data-failed", "1");
		el_status.innerText = text;
		if (__failed_timer !== null) {
			clearTimeout(__failed_timer);
		}
		__failed_timer = setTimeout(function() {
			__failed_timer = null;
			el.removeAttribute("data-failed");
			el_status.innerText = "";
		}, PROBLEM_SHOWN_MS);
	};

	// Everything the page can see standing between a keystroke and the host, in
	// the words of whatever is doing it -- or null when nothing is.
	//
	// The mute branch does NOT gate anything: the switch is enforced by the two
	// transports (session.js, print.js) and would be obeyed with every line of
	// this deleted. What is decided here is only what the user is TOLD, which is
	// the half a transport cannot do -- it has no idea which surface it is
	// carrying for. The switch takes precedence over the HID's readiness because
	// it is a fact and readiness is an inference.
	var __whyBlocked = function() {
		if (hidMuted()) {
			return MUTED_SAID;
		}
		if (!__hidReady()) {
			return `${__whyNotReady()} \u2014 this may not have arrived`;
		}
		return null;
	};

	// Said when the page can see the keystroke will not get there. Fired per
	// burst rather than once per session on purpose: it is the answer to "did
	// that arrive?", asked at the moment the user asks it.
	var __warnBeforeSend = function() {
		let why = __whyBlocked();
		if (why !== null) {
			__sayTyping(why);
		}
	};

	var __initTyping = function() {
		let el = $("hid-type-input");
		if (el === null) {
			return; // Desktop pages do not render the typing bar
		}

		__queue = makeTypingQueue({
			"print": function(text, keymap, done) {
				__warnBeforeSend();
				if (!__linkUp()) {
					// HTTP can still be up while the socket is not, and then
					// the text would land while the Backspace behind it was
					// dropped. A null `info` says the page refused, not kvmd.
					done(false, null);
					return;
				}
				printText(text, keymap, 0, function(http) {
					if (http === null) {
						// Muted: print.js sent nothing. Work queued before the
						// switch was thrown must not leak out after it either, so
						// what is still behind this goes with it -- and it is not
						// a failure to announce, because __warnBeforeSend has
						// already said what happened.
						done(false, null);
						return;
					}
					if (http.status === 200) {
						// The Text menu records its prints; a recording made through
						// the bar that held the Enters and none of the text would
						// replay a bare Enter into whatever is on screen.
						__recordPrintEvent(text, keymap, 0);
					}
					done(http.status === 200, http);
				}, {"timeout": TYPING_TIMEOUT_MS});
			},
			"sendKey": function(code, state) {
				// Reports DELIVERABILITY, not whether anything was sent: a
				// muted HID is a deliberate silence, an unreachable one is a
				// failure, and the queue needs to tell them apart to decide
				// whether the text behind this key may still go out.
				if (!__linkUp()) {
					return false;
				}
				__warnBeforeSend();
				// The board goes down for a key exactly as it does for text:
				// Backspace under a latched Ctrl is delete-word in a shell, and
				// Enter under it is not Enter. This is the other transport --
				// print.js cannot reach it.
				self.releaseAll();
				__sendKey(code, state);
				return true;
			},
			"getKeymap": function() {
				// The Text menu already owns the keymap chooser; reuse it
				// rather than offering a second one that could disagree.
				let el_km = $("hid-pak-keymap-selector");
				return ((el_km !== null && el_km.value) ? el_km.value : "en-us");
			},
			"onError": function(why) {
				if (why === null) {
					return; // A deliberate drop, not a failure
				}
				// A status only exists when kvmd answered. A key whose socket
				// was gone, and a print the page refused for the same reason,
				// both arrive here without one -- and both mean the link.
				let status = ((why.what === "print" && why.http !== null) ? why.http.status : 0);
				if (status > 0) {
					// The body can hold what the user typed, so it is not logged.
					tools.error("Keyboard: typing failed with HTTP", status);
					__sayTyping(`Not sent \u2014 PiKVM error ${status}`, true);
				} else if (hidMuted()) {
					// The page refused on the user's own switch, which is not an
					// error and is not the link: saying "no connection to PiKVM"
					// here would send someone debugging their network.
					__sayTyping(MUTED_SAID, true);
				} else {
					tools.error("Keyboard: typing failed: the HID connection is down");
					__sayTyping("Not sent \u2014 no connection to PiKVM", true);
				}
			},
		});

		// While the system keyboard is up, the scancode layers are redundant --
		// Android already has the letters -- and they are eating the screen. Only
		// what a phone keyboard CANNOT send stays: Esc, the modifiers, Tab and
		// the arrows. The layer picker stays too, so the full board is one tap
		// away; tapping it dismisses the system keyboard.
		// On a phone this window is opened to TYPE far more often than to send a
		// scancode, and the bar that starts that sits BELOW the whole board --
		// which is exactly why it gets missed. Opening straight into typing mode
		// puts the phone's own keyboard up with only the keys it cannot send
		// above it. The layer picker still expands the full board in one tap.
		let el_win = $("keyboard-window");
		if (el_win !== null) {
			el_win.show_hook = function() {
				if (document.documentElement.getAttribute("data-ui") === UI_MOBILE) {
					el.focus();
				}
			};
		}

		el.addEventListener("focus", function() {
			if (__blur_timer !== null) {
				clearTimeout(__blur_timer);
				__blur_timer = null;
			}
			// The padding only has to exist while a soft keyboard is looking at
			// the field. Installing it on focus keeps the field genuinely empty
			// the rest of the time, which is what lets the placeholder render.
			__resetField(el);
			document.documentElement.setAttribute("data-typing", "1");
			wm.organizeAllWindows();
		});
		__exitTyping = function() {
			// An explicit layer choice is not the momentary blur the debounce
			// below exists to absorb, so it leaves typing mode at once. Waiting
			// out the 200ms meant the board did not come back on the tap that
			// asked for it, which is the whole of "one tap away".
			if (__blur_timer !== null) {
				clearTimeout(__blur_timer);
				__blur_timer = null;
			}
			el.blur();
			document.documentElement.removeAttribute("data-typing");
			wm.organizeAllWindows();
		};

		el.addEventListener("blur", function(ev) {
			__clearField(el);
			// Typing mode is a MODE, not a shadow of where focus happens to be.
			// Focus moving to another CONTROL is not a decision to leave it:
			// tapping the mouse button in this window's own header blurred the
			// bar, so 200ms later the full scancode board unfolded over the
			// pad the user had just asked for -- reported from a phone as
			// "i click mouse and it opens full on screen pikvm keyboard".
			// relatedTarget is null only when focus went NOWHERE, which is what
			// dismissing the system keyboard does; then the board is welcome
			// back, because the space it was making way for has gone.
			if (ev.relatedTarget !== null) {
				return;
			}
			// Pressing a key in the strip must not collapse and re-expand the
			// sheet under the user's finger, so a momentary blur is ignored.
			__blur_timer = setTimeout(function() {
				__blur_timer = null;
				document.documentElement.removeAttribute("data-typing");
				wm.organizeAllWindows();
			}, 200);
		});

		// An IME composes a word in place, firing an input event per character.
		// Those are forwarded like any other edit: the host has to track the
		// finger, not lag a word behind it. Suppressing them until the word
		// committed is what made the field disagree with the console -- the
		// letters sat in the box, the console stayed blank, and a delete inside
		// the word reached the host as nothing at all.
		//
		// What composition DOES gate is the reset: the field is the IME's own
		// workspace until it commits, so it is left alone until then.
		el.addEventListener("compositionstart", function() {
			__composing = true;
		});
		el.addEventListener("compositionend", function() {
			__composing = false;
			if (document.activeElement !== el) {
				// Blur and compositionend arrive in either order depending on the
				// engine. Blink commits first, so this is unreachable there -- but
				// the other way round the field has already been emptied, and
				// decoding against that would type the abandoned word at the host
				// and re-pad a blurred field so its placeholder never came back.
				return;
			}
			// Engines disagree about whether the final input event comes before
			// or after this one, so both paths decode. Whichever runs second
			// sees no change and emits nothing.
			__onEdit(el, null);
		});
		el.addEventListener("input", function(ev) {
			__onEdit(el, ev.inputType);
		});
		el.addEventListener("keydown", function(ev) {
			// A chord is not the bar's: __isTypingBarKey lets Ctrl/Alt/Meta+Enter
			// through to the scancode path, so handling it here too sent Enter
			// TWICE -- the immediate copy ahead of its own text, which is the
			// defect this phase exists to fix, gated behind a modifier.
			if (ev.key === "Enter" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
				// preventDefault stops the single-line field submitting, and is
				// why no input event follows this to double the Enter.
				ev.preventDefault();
				// Queued, not sent: Enter runs the command, so it must not reach
				// the host before the characters of that command do. Whether it
				// leaves at all is the socket's decision, one layer down.
				__queue.push([{"key": "Enter", "n": 1}]);
				__composing = false;
				__resetField(el);
			}
		});

		// The way back to the full board while the system keyboard is up. The
		// layer picker does this too, but it is a whole row of its own and in
		// typing mode only one of its five buttons means anything.
		tools.el.setOnClick($("hid-type-board"), function() {
			if (__exitTyping !== null) {
				__exitTyping();
			}
		});

		tools.el.setOnClick($("hid-type-clear"), function() {
			// Local only -- clears the field, never touches the host.
			__resetField(el);
			el.focus();
		});
	};

	// The field is put back to its padding after every edit, so nothing
	// accumulates in it. It happens on the next task rather than inside the
	// handler: mutating the value a soft keyboard is mid-way through reading is
	// how an IME ends up duplicating what it just inserted.
	var __scheduleReset = function(el) {
		if (__reset_timer !== null) {
			return;
		}
		__reset_timer = setTimeout(function() {
			__reset_timer = null;
			if (__composing) {
				return; // The IME still owns the field; compositionend reschedules
			}
			__resetField(el);
		}, 0);
	};

	var __resetField = function(el) {
		el.value = PAD;
		__typed = PAD;
		// Programmatic assignment fires no input event, so this cannot loop.
		el.setSelectionRange(PAD.length, PAD.length);
	};

	var __clearField = function(el) {
		// Composition state is otherwise cleared ONLY by compositionend, and an
		// Android tab frozen mid-word never fires one -- leaving __composing
		// latched, every later reset skipped, and the field back to being the
		// accumulating transcript this phase set out to delete.
		__composing = false;
		__bar_keys.clear();
		// A reset still pending from the last edit would put the padding back
		// after this, and a field that is not empty renders no placeholder -- so
		// leaving typing mode would leave an empty-looking box with no hint in it.
		if (__reset_timer !== null) {
			clearTimeout(__reset_timer);
			__reset_timer = null;
		}
		el.value = "";
		__typed = "";
	};

	var __onEdit = function(el, input_type) {
		let was = __typed;
		let now = el.value;
		__typed = now;
		__scheduleReset(el);
		// Decoded and queued whatever the mute switch says: the transports refuse,
		// the queue drops what was behind the refusal, and the bar says which
		// switch did it. A third copy of the rule here would gate the other two
		// out of reach -- deleting either would then change nothing anybody could
		// measure, which is how a guard rots.
		__queue.push(decodeEdit({"was": was, "now": now, "input_type": input_type}));
	};

	// The compact board shows one layer at a time. Desktop ignores this
	// entirely -- it shows every key at once and the picker is not rendered.
	var __setLayer = function(layer) {
		let el_keypad = $("keyboard-compact");
		if (el_keypad === null) {
			return;
		}
		el_keypad.setAttribute("data-layer", layer);
		tools.storage.set("hid.keyboard.layer", layer);
		for (let el_bt of $$$("[data-keypad-layer-button]")) {
			let on = (el_bt.getAttribute("data-keypad-layer-button") === layer);
			el_bt.setAttribute("aria-pressed", String(on));
		}
	};

	var __initLayers = function() {
		for (let el_bt of $$$("[data-keypad-layer-button]")) {
			tools.el.setOnClick(el_bt, function() {
				// Choosing a layer means you want the scancode board, so let go
				// of the typing field and put the system keyboard away.
				if (__exitTyping !== null) {
					__exitTyping();
				}
				__setLayer(el_bt.getAttribute("data-keypad-layer-button"));
			});
		}
		__setLayer(tools.storage.get("hid.keyboard.layer", "abc"));
	};

	var __innerSendKey = function(code, state, allow_finish) {
		tools.debug("Keyboard: key", (state ? "pressed:" : "released:"), code);
		let ev = {
			"event_type": "key",
			"event": {
				"key": code,
				"state": state,
				"finish": (allow_finish && $("hid-keyboard-bad-link-switch").checked),
			},
		};
		// Muted or not is sendHidEvent's to decide -- every writer of the socket
		// goes through it, and this is only one of three. ⚠ The line above says
		// the KEYBOARD emitted this, which is not the same as the host getting
		// it: it has always been logged with no socket at all. What reached the
		// wire is read from the wire -- browser.mjs decodes the frames.
		if (__ws) {
			__ws.sendHidEvent(ev);
		}
		delete ev.event.finish;
		__recordWsEvent(ev);
	};

	__init__();
}
