const { withPodfile } = require("@expo/config-plugins");

// Xcode 27 raised the minimum iOS Simulator deployment target it will build
// for to 15.0. A few transitive pods (e.g. RNCAsyncStorage's resource
// bundle, SDWebImage) still declare much older per-target deployment
// targets (9.0, 13.4) that CocoaPods carries straight through, which makes
// the build fail with an "IPHONEOS_DEPLOYMENT_TARGET ... range of supported
// deployment target versions is 15.0 to 27.0.x" error. This forces every
// pod target below 15.0 up to the project's minimum in post_install, same
// as react_native_post_install already does for the app's own target.
// Remove this once the offending pods bump their deployment targets upstream.

const POST_INSTALL_ANCHOR = "react_native_post_install(";

const DEPLOYMENT_TARGET_FIX = `
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        deployment_target = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if deployment_target && deployment_target.to_f < 15.0
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
        end
      end
    end
`;

module.exports = function withXcode27PodDeploymentTarget(config) {
  return withPodfile(config, (config) => {
    let contents = config.modResults.contents;

    if (contents.includes("IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'")) {
      return config;
    }

    if (!contents.includes(POST_INSTALL_ANCHOR)) {
      throw new Error(
        "withXcode27PodDeploymentTarget: couldn't find 'react_native_post_install(' in the generated Podfile — the Expo template may have changed. Update plugins/withXcode27PodDeploymentTarget.js."
      );
    }

    const insertAt = contents.indexOf(POST_INSTALL_ANCHOR);
    const closeParenIdx = contents.indexOf(")\n", insertAt);
    if (closeParenIdx === -1) {
      throw new Error(
        "withXcode27PodDeploymentTarget: couldn't find the end of the react_native_post_install(...) call in the generated Podfile — update plugins/withXcode27PodDeploymentTarget.js."
      );
    }
    const insertPoint = closeParenIdx + 2;

    contents = contents.slice(0, insertPoint) + DEPLOYMENT_TARGET_FIX + contents.slice(insertPoint);

    config.modResults.contents = contents;
    return config;
  });
};
