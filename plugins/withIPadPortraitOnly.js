const { withInfoPlist } = require("@expo/config-plugins");

// Landscape exists for the iPhone Week view only (unlocked at runtime via
// expo-screen-orientation). expo-screen-orientation's own plugin writes the
// app-wide orientation list to the iPad key as well, and on iPad a runtime
// lock is ignored unless the app gives up Split View (UIRequiresFullScreen),
// so without this every iPad screen would rotate. Pins iPad back to
// portrait, matching the layout Apple already reviewed.

const PORTRAIT = ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown"];

module.exports = function withIPadPortraitOnly(config) {
  return withInfoPlist(config, (config) => {
    config.modResults["UISupportedInterfaceOrientations~ipad"] = PORTRAIT;
    return config;
  });
};
