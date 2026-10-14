// The app shares code with the rest of the repo instead of copying it: the remote protocol
// (../src/remote/protocol.ts) and the desktop app's session reducer (../niti-app/src/renderer/src/lib).
// Metro watches those folders, and resolves their imports (tweetnacl) from this app's node_modules,
// which is the only node_modules an EAS build installs.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../src/remote"), path.resolve(__dirname, "../niti-app/src/renderer/src/lib")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
