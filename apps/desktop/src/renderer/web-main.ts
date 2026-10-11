/**
 * Web dev entry: install the HTTP bridge in place of the Electron preload,
 * then boot the untouched renderer.
 */
import { installWebBridge } from "./src/webBridge";

installWebBridge();
void import("./src/main");
