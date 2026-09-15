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
// parseOptsFromUrlQuery, spread last into applyPreferences).
//
// xterm's default is 15px: on a 390px phone that is 43 columns of type too
// small to read at arm's length. 18px is about 36 columns -- fewer, and legible,
// which is the trade a phone wants. The desktop keeps the default.
export const WEBTERM_COMPACT_FONT_PX = 18;

export function webtermUrl(base, path, compact) {
	// The trailing slash avoids an Nginx 301 when the location has none, which
	// a reverse proxy in front of PiKVM can be misconfigured to mishandle.
	let url = base + path + "/?disableLeaveAlert=true";
	return (compact ? `${url}&fontSize=${WEBTERM_COMPACT_FONT_PX}` : url);
}
