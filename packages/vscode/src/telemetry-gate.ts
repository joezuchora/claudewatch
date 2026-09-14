/**
 * Extension telemetry consent gate.
 *
 * VS Code's telemetry guidance for extension authors is explicit:
 *
 *   "Extension authors must respect the user's choice by utilizing the isTelemetryEnabled
 *    and onDidChangeTelemetryEnabled API. If isTelemetryEnabled reports false, even if your
 *    setting is enabled, telemetry must not be sent."
 *
 * So the gate is the logical AND of VS Code's global switch and ClaudeWatch's own setting.
 * VS Code's switch can only ever subtract — it can never enable telemetry for a user who did
 * not ask for it.
 *
 * Pure, and deliberately so: this is the compliance requirement in its entirety, and testing
 * it through a mocked extension host would test the mock.
 */

/**
 * @param globalEnabled  `vscode.env.isTelemetryEnabled`, or whatever a host provided.
 * @param settingEnabled `claudewatch.telemetry.enabled`.
 *
 * Fails closed. `undefined` from a host predating the API, a non-boolean, or the sentinel a
 * caller passes after a read threw, are all treated as "no" — an unknown consent state is
 * not consent.
 */
export function resolveExtensionTelemetry(
  globalEnabled: unknown,
  settingEnabled: unknown,
): boolean {
  return globalEnabled === true && settingEnabled === true;
}
