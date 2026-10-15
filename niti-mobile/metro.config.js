// The app shares code with the rest of the repo instead of copying it: the remote protocol
// (../src/remote/protocol.ts), the desktop app's session reducer (../niti-app/src/renderer/src/lib)
// and its agent avatars (../niti-app/src/renderer/src/assets/avatars).
// Metro watches those folders, and also resolves their imports (tweetnacl) from this app's node_modules,
// which is the only node_modules an EAS build installs.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
config.watchFolders = ["../src/remote", "../niti-app/src/renderer/src/lib", "../niti-app/src/renderer/src/assets/avatars"].map((p) => path.resolve(__dirname, p));
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
