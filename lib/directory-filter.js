const { repoForPath } = require("./helpers");

// Capture the directory policy once so an asynchronous scan never mixes
// settings from before and after a configuration change.
module.exports = function createDirectoryFilter(directoryPath, ignoredNames) {
  const hideNames = lumine.config.get("tree-view.hideIgnoredNames");
  const repository = lumine.config.get("tree-view.hideVcsIgnoredFiles")
    ? repoForPath(directoryPath)
    : null;
  return (fullPath) =>
    Boolean(
      repository?.isPathIgnoredCached(fullPath) || (hideNames && ignoredNames.matches(fullPath)),
    );
};
