/**
 * A destination with an unsaved draft registers a leave guard here. Settings
 * navigation asks it before changing the rail destination, so a mode editor
 * cannot be discarded by a single click on another tab.
 */
type LeaveGuard = () => boolean;

let leaveGuard: LeaveGuard | null = null;

export function setSettingsLeaveGuard(guard: LeaveGuard | null): void {
  leaveGuard = guard;
}

/** True when leaving is allowed; false means the destination stays. */
export function confirmSettingsLeave(): boolean {
  return leaveGuard ? leaveGuard() : true;
}
