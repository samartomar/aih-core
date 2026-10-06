import type { MacosSessionControls, MacosGuiSessionObservation, MacosApplicationRequest,
  MacosApplicationObservation, MacosGuiKeyRequest, MacosGuiKeyRead, MacosSessionLaunchAgent } from './macos-session.mjs';
export { macosSessionBudgets, macosSessionTrustKeys } from './macos-session.mjs';
export declare function renderMacosSessionLaunchAgent(intent: unknown): MacosSessionLaunchAgent |
  { status: 'invalid'; code: 'INPUT_INVALID'; reason: string };
export declare function observeMacosGuiSession(controls?: MacosSessionControls): Promise<MacosGuiSessionObservation>;
export declare function observeMacosApplication(request: MacosApplicationRequest,
  controls?: MacosSessionControls): Promise<MacosApplicationObservation>;
export declare function readMacosGuiDomainKey(request: MacosGuiKeyRequest,
  controls?: MacosSessionControls): Promise<MacosGuiKeyRead>;
