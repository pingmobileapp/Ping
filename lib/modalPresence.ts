import { useEffect, useSyncExternalStore } from 'react';

// Tracks how many full-screen sheets (React Native <Modal>s) are open, so the
// global InvitePopup never presents on top of - or underneath - another one.
// On iOS, two RN Modals from different parts of the tree can't be stacked
// safely: dismissing the lower one dismisses everything presented above it
// at the UIKit level, while React still thinks the upper one is showing,
// leaving an invisible layer that swallows every tap. That's the "I accepted
// an event and then the screen froze" report (TestFlight, build 114): an
// invite popup and an event card were open at the same time.

let openCount = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => openCount > 0;

// Call from any sheet with its `visible` flag.
export function useRegisterModal(visible: boolean) {
  useEffect(() => {
    if (!visible) return;
    openCount += 1;
    emit();
    return () => {
      openCount -= 1;
      emit();
    };
  }, [visible]);
}

// True while at least one registered sheet is open.
export function useAnyModalOpen() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
