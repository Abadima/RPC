/**
 * Whether this is Firefox. The `browser` global can't say: Firefox has it,
 * and so does current Chrome (153 does), so a check on it picks Firefox's
 * extension ids in Chrome. Extension pages tell it apart: Firefox's are
 * `moz-extension://`, Chromium's `chrome-extension://`.
 */
export const onFirefox = (): boolean => chrome.runtime.getURL("").startsWith("moz-extension:");
