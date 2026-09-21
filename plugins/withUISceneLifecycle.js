const { withInfoPlist, withAppDelegate } = require("@expo/config-plugins");

// Xcode 27 / iOS 27 refuse to launch apps that haven't adopted UIKit's
// scene-based life cycle ("UIScene life cycle is required for apps built
// with this SDK"). Expo doesn't ship native scene support until SDK 58
// (expo-build-properties' `enableSceneSupport` only backports it to SDK 57+),
// and this project is on SDK 54, so this plugin backports it by hand:
// it adds the UIApplicationSceneManifest to Info.plist and moves React
// Native's window creation out of AppDelegate and into a SceneDelegate.
// Workaround source: https://github.com/expo/expo/issues/50179
// Remove this plugin once the project upgrades to an Expo SDK with native
// scene lifecycle support (SDK 58+).

function withUISceneManifest(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return config;
  });
}

const LAUNCH_OPTIONS_PROPERTY = "var launchOptions: [UIApplication.LaunchOptionsKey: Any]?";

const OLD_LAUNCH_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const NEW_LAUNCH_BLOCK = `self.launchOptions = launchOptions

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const SCENE_DELEGATE_CLASS = `class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions)

    if let urlContext = connectionOptions.urlContexts.first {
      RCTLinkingManager.application(UIApplication.shared, open: urlContext.url, options: [:])
    }
    if let userActivity = connectionOptions.userActivities.first {
      RCTLinkingManager.application(
        UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(
      UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}

`;

function withUISceneAppDelegate(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      throw new Error(
        "withUISceneLifecycle: expected a Swift AppDelegate (got '" +
          config.modResults.language +
          "'). This plugin only knows how to patch the Swift template."
      );
    }

    let contents = config.modResults.contents;

    if (contents.includes(LAUNCH_OPTIONS_PROPERTY)) {
      // Already patched (shouldn't normally happen within a single prebuild,
      // but keep this idempotent just in case).
      return config;
    }

    if (!contents.includes("var window: UIWindow?")) {
      throw new Error(
        "withUISceneLifecycle: couldn't find 'var window: UIWindow?' in AppDelegate.swift — the Expo template may have changed. Update plugins/withUISceneLifecycle.js."
      );
    }
    contents = contents.replace(
      "var window: UIWindow?",
      "var window: UIWindow?\n  " + LAUNCH_OPTIONS_PROPERTY
    );

    if (!contents.includes(OLD_LAUNCH_BLOCK)) {
      throw new Error(
        "withUISceneLifecycle: couldn't find the expected didFinishLaunchingWithOptions body in AppDelegate.swift — the Expo template may have changed. Update plugins/withUISceneLifecycle.js."
      );
    }
    contents = contents.replace(OLD_LAUNCH_BLOCK, NEW_LAUNCH_BLOCK);

    const classAnchor = "class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {";
    if (!contents.includes(classAnchor)) {
      throw new Error(
        "withUISceneLifecycle: couldn't find 'class ReactNativeDelegate' in AppDelegate.swift — the Expo template may have changed. Update plugins/withUISceneLifecycle.js."
      );
    }
    contents = contents.replace(classAnchor, SCENE_DELEGATE_CLASS + classAnchor);

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = function withUISceneLifecycle(config) {
  config = withUISceneManifest(config);
  config = withUISceneAppDelegate(config);
  return config;
};
