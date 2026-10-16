const path = require("path");
const { CompositeDisposable, watchDirectory: watchFilesystemDirectory } = require("lumine");
const fs = require("./fs-compat");
const IgnoredNames = require("./ignored-names");
const createDirectoryFilter = require("./directory-filter");
const readDirectoryEntries = require("./directory-reader");
const { sortEntriesByName } = require("./entry-sorting");

function ignoredNamesRoot(directoryPath) {
  let rootPath = directoryPath;
  let longestRoot = -1;
  for (const projectPath of lumine.project.getPaths()) {
    const candidate = path.resolve(projectPath);
    const relative = path.relative(candidate, directoryPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    if (candidate.length > longestRoot) {
      rootPath = candidate;
      longestRoot = candidate.length;
    }
  }
  return rootPath;
}

async function listFiles(directoryPath) {
  const fullPath = path.resolve(directoryPath);
  const options = {
    sortMethod: lumine.config.get("tree-view.sortMethod") ?? "default",
    sortByBase: lumine.config.get("tree-view.sortByBase") ?? true,
  };
  const ignoredNames = new IgnoredNames(ignoredNamesRoot(fullPath));
  // The shared reader only needs these filesystem facts. Reading a directory
  // for another package must not construct tree models, watchers or dock UI.
  const directory = {
    path: fullPath,
    realPath: fullPath,
    hasEntryOfKind: () => false,
    async loadRealPathPromise() {
      try {
        this.realPath = await fs.promises.realpath(this.path);
      } catch {
        // The reader handles missing and unreadable directories as empty.
      }
    },
  };
  const records = await readDirectoryEntries(directory, {
    isPathIgnored: createDirectoryFilter(fullPath, ignoredNames),
    squashDirectoryNames: false,
  });
  return sortEntriesByName(
    records.filter((record) => record.kind === "file"),
    options,
  ).map((record) => record.fullPath);
}

function onDidChange(callback) {
  const subscriptions = new CompositeDisposable();
  const repositorySubscriptions = new Map();
  const refreshRepositories = () => {
    const repositories = new Set(lumine.repositories.getRepositories());
    for (const [repository, subscription] of repositorySubscriptions) {
      if (repositories.has(repository)) continue;
      subscriptions.remove(subscription);
      subscription.dispose();
      repositorySubscriptions.delete(repository);
    }
    for (const repository of repositories) {
      if (repositorySubscriptions.has(repository)) continue;
      const subscription = repository.onDidChangeStatusSnapshot(() => {
        if (lumine.config.get("tree-view.hideVcsIgnoredFiles")) callback();
      });
      repositorySubscriptions.set(repository, subscription);
      subscriptions.add(subscription);
    }
  };
  for (const key of [
    "tree-view.sortMethod",
    "tree-view.sortByBase",
    "tree-view.sortFoldersBeforeFiles",
    "tree-view.hideIgnoredNames",
    "tree-view.hideVcsIgnoredFiles",
    "core.ignoredNames",
  ]) {
    subscriptions.add(lumine.config.onDidChange(key, callback));
  }
  subscriptions.add(
    lumine.project.onDidChangePaths(callback),
    lumine.project.onDidInvalidateFiles(callback),
    lumine.repositories.onDidChange(() => {
      refreshRepositories();
      callback();
    }),
  );
  refreshRepositories();
  return subscriptions;
}

function watchDirectory(directoryPath, callback) {
  const watcher = watchFilesystemDirectory(path.resolve(directoryPath), { recursive: false });
  const subscriptions = new CompositeDisposable(
    watcher,
    watcher.onDidChange((events) => {
      if (events.some((event) => event.action !== "updated")) callback();
    }),
    watcher.onDidInvalidate(() => callback()),
    watcher.onDidError((error) => console.error("Unable to watch tree directory", error)),
  );
  return {
    ready: watcher.ready,
    dispose: () => subscriptions.dispose(),
  };
}

module.exports = { listFiles, onDidChange, watchDirectory };
