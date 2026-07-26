/**
 * Which desktop we're running on, for the few places the chrome differs.
 *
 * On macOS the window uses `titleBarStyle: "Overlay"`, so the real traffic
 * lights float over the top-left of our content. Anything we draw up there has
 * to move out of their way — hence the padding constants below. Faking the
 * traffic lights ourselves would look wrong to any Mac user, so we don't.
 *
 * Windows and Linux keep their ordinary system title bar for now, which is why
 * every value here is zero off macOS.
 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Macintosh") || navigator.userAgent.includes("Mac OS"));

/** Clearance needed to the left of content that sits in the title bar strip. */
export const TRAFFIC_LIGHT_INSET = IS_MAC ? 78 : 0;

/** Vertical clearance for content stacked below the title bar strip. */
export const TITLE_BAR_HEIGHT = IS_MAC ? 28 : 0;
