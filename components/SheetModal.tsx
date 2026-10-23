import React, { createContext, useContext } from 'react';
import { Modal, ModalProps, View } from 'react-native';

// The device's real side insets, from the app root (see SideInsets in
// app/_layout.tsx). Screens there see left/right as 0 because the root
// already pads for them - but a Modal opens in its own window, outside that
// padding.
export const RootSideInsetsContext = createContext({ left: 0, right: 0 });

// A slide-up sheet's Modal, kept clear of side insets the way every screen
// is. On the folded iPhone Duo the system rail down the right edge covered
// an event's ••• menu (Hide, Report) - 2026-10-22.
export default function SheetModal({ children, ...props }: ModalProps & { children?: React.ReactNode }) {
  const { left, right } = useContext(RootSideInsetsContext);
  return (
    <Modal {...props}>
      <View style={{ flex: 1, paddingLeft: left, paddingRight: right }}>{children}</View>
    </Modal>
  );
}
