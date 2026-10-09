/** Hand the official authorization URL to the desktop shell's external-link path. */

import { isAllowedAuthorizationUrl } from '../shared/index.ts'

/**
 * Ask the desktop shell to open one authorization URL.
 *
 * The shared gate runs here as well as where the attempt decides what to do
 * with the URL: this function is the only place the page hands an address to the
 * shell, so the check travels with the outbound call.
 *
 * Electron's `setWindowOpenHandler` answers `deny` after handing the URL to
 * `shell.openExternal`, so a `null` return is the normal outcome and says
 * nothing about whether the browser opened. Only a synchronous throw is
 * reportable, and the caller treats that as an open failure.
 * @param url - the authorization URL of the attempt being observed.
 */
export function openAuthorizationInBrowser(url: string): void {
  if (!isAllowedAuthorizationUrl(url)) return
  window.open(url, '_blank', 'noopener,noreferrer')
}
