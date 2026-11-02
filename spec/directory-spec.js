const { Disposable } = require("lumine");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Directory = require("../lib/directory");
const repositoryStatusObserver = require("../lib/repository-status-observer");

function repositoryFor({
  directoryStatusSummary = null,
  pathStatusSummary = null,
  ignoredPaths = [],
  workingDirectory = os.tmpdir(),
} = {}) {
  const statusesCallbacks = [];
  return {
    getStatusSnapshot: () => ({
      initialized: true,
      includesIgnored: true,
      files: ignoredPaths.map((path) => ({ path, ignored: true })),
    }),
    getDirectoryStatusSummary: jasmine
      .createSpy("getDirectoryStatusSummary")
      .and.returnValue(directoryStatusSummary),
    getPathStatusSummary: jasmine
      .createSpy("getPathStatusSummary")
      .and.returnValue(pathStatusSummary),
    isPathIgnoredCached: jasmine
      .createSpy("isPathIgnoredCached")
      .and.callFake((candidate) => ignoredPaths.includes(candidate)),
    getWorkingDirectory() {
      return workingDirectory;
    },
    isSubmodule() {
      return false;
    },
    // Recorded rather than ignored: firing the callback back is how a spec
    // tells a live subscription from one that was disposed with its entry.
    onDidChangeStatusSnapshot(callback) {
      statusesCallbacks.push(callback);
      return new Disposable(() => {
        const index = statusesCallbacks.indexOf(callback);
        if (index !== -1) statusesCallbacks.splice(index, 1);
      });
    },
    notifyStatusesChanged() {
      for (const callback of statusesCallbacks.slice()) callback();
    },
    subscriberCount() {
      return statusesCallbacks.length;
    },
  };
}

function createDirectory(
  fullPath,
  repository,
  { isRoot = false, ignoredNames, isExpanded = false } = {},
) {
  spyOn(lumine.repositories, "getForPath").and.returnValue(repository);
  return new Directory({
    name: "repository",
    fullPath,
    isRoot,
    expansionState: { isExpanded },
    ignoredNames: ignoredNames ?? { matches: () => false },
    useSyncFS: true,
  });
}

describe("TreeView Directory decorations and Git status", () => {
  let directory;
  let temporaryDirectories;

  beforeEach(() => {
    temporaryDirectories = [];
  });

  function makeTemporaryDirectory(name) {
    const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    temporaryDirectories.push(directoryPath);
    return directoryPath;
  }

  afterEach(() => {
    directory?.destroy();
    for (const directoryPath of temporaryDirectories) {
      // Retries because Windows keeps a directory non-empty until the last handle on a
      // child closes, and `force` swallows only ENOENT.
      fs.rmSync(directoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("colors a directory from the repository's directory status summary", () => {
    const directoryPath = makeTemporaryDirectory("summary-modified-directory");
    const repository = repositoryFor({
      directoryStatusSummary: { source: "cache", conflicted: false, modified: true, added: false },
    });

    directory = createDirectory(directoryPath, repository);

    expect(directory.status).toBe("modified");
    expect(repository.getDirectoryStatusSummary).toHaveBeenCalledWith(directoryPath);
  });

  it("gives conflicts priority over other states", () => {
    const directoryPath = makeTemporaryDirectory("summary-conflicted-directory");
    const repository = repositoryFor({
      directoryStatusSummary: {
        source: "snapshot",
        conflicted: true,
        modified: true,
        added: true,
      },
    });

    directory = createDirectory(directoryPath, repository);

    expect(directory.status).toBe("conflicted");
  });

  it("stays uncolored when the summary reports nothing below the directory", () => {
    const directoryPath = makeTemporaryDirectory("summary-clean-directory");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository, { isRoot: true });

    expect(directory.status).toBeNull();
    expect(repository.getDirectoryStatusSummary).toHaveBeenCalledWith(directoryPath);
  });

  it("tracks core.ignoredNames separately from Git status", () => {
    const directoryPath = makeTemporaryDirectory("ignored-name-directory");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository, {
      ignoredNames: { matches: (candidate) => candidate === directoryPath },
    });

    expect(directory.ignoredByName).toBe(true);
    expect(directory.status).toBeNull();
  });

  it("keeps the Git status of a directory whose path matches core.ignoredNames", () => {
    const directoryPath = makeTemporaryDirectory("ignored-name-modified-directory");
    const repository = repositoryFor({
      directoryStatusSummary: { source: "cache", conflicted: false, modified: true, added: false },
    });

    directory = createDirectory(directoryPath, repository, {
      ignoredNames: { matches: (candidate) => candidate === directoryPath },
    });

    expect(directory.ignoredByName).toBe(true);
    expect(directory.status).toBe("modified");
  });

  it("marks a visible child file whose path matches core.ignoredNames", () => {
    const directoryPath = makeTemporaryDirectory("ignored-name-child");
    const ignoredPath = path.join(directoryPath, "debug.log");
    fs.writeFileSync(ignoredPath, "ignored");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository, {
      ignoredNames: { matches: (candidate) => candidate === ignoredPath },
    });
    directory.reload();

    expect(directory.entries.get("debug.log").ignoredByName).toBe(true);
  });

  it("retains ignored children and their identities when display filters change", () => {
    const previousNames = lumine.config.get("tree-view.hideIgnoredNames");
    const previousVcs = lumine.config.get("tree-view.hideVcsIgnoredFiles");
    const directoryPath = makeTemporaryDirectory("retained-ignored-children");
    const ignoredPath = path.join(directoryPath, "debug.log");
    const ignoredDirectoryPath = path.join(directoryPath, "build");
    fs.writeFileSync(ignoredPath, "ignored");
    fs.mkdirSync(ignoredDirectoryPath);
    const repository = repositoryFor({ ignoredPaths: [ignoredDirectoryPath] });

    try {
      lumine.config.set("tree-view.hideIgnoredNames", true);
      lumine.config.set("tree-view.hideVcsIgnoredFiles", true);
      directory = createDirectory(directoryPath, repository, {
        ignoredNames: { matches: (candidate) => candidate === ignoredPath },
      });
      directory.reload();
      const file = directory.entries.get("debug.log");
      const childDirectory = directory.entries.get("build");
      expect(file.ignoredByName).toBe(true);
      expect(childDirectory.status).toBe("ignored");
      const removed = [];
      const added = [];
      directory.onDidRemoveEntries((entries) => removed.push(...entries));
      directory.onDidAddEntries((entries) => added.push(...entries));

      lumine.config.set("tree-view.hideIgnoredNames", false);
      lumine.config.set("tree-view.hideVcsIgnoredFiles", false);
      directory.reload();

      expect(directory.entries.get("debug.log")).toBe(file);
      expect(directory.entries.get("build")).toBe(childDirectory);
      expect(removed).toEqual([]);
      expect(added).toEqual([]);
    } finally {
      lumine.config.set("tree-view.hideIgnoredNames", previousNames);
      lumine.config.set("tree-view.hideVcsIgnoredFiles", previousVcs);
    }
  });

  it("preserves the source path of a synchronously squashed directory for filtering", () => {
    const previous = lumine.config.get("tree-view.squashDirectoryNames");
    const directoryPath = makeTemporaryDirectory("squashed-source-path");
    const childPath = path.join(directoryPath, "build");
    const nestedPath = path.join(childPath, "nested");
    fs.mkdirSync(nestedPath, { recursive: true });

    try {
      lumine.config.set("tree-view.squashDirectoryNames", true);
      directory = createDirectory(directoryPath, null, { isRoot: true });
      directory.reload();

      const child = directory.entries.get("build");
      expect(child.path).toBe(nestedPath);
      expect(child.sourcePath).toBe(childPath);
    } finally {
      lumine.config.set("tree-view.squashDirectoryNames", previous);
    }
  });
});

// The registry discovers repositories asynchronously — it scans each project
// root for nested checkouts once the window is up — so an entry is routinely
// built before the repository it belongs to exists. It used to learn about one
// only by being thrown away and rebuilt.
describe("TreeView Directory repository routing", () => {
  let directory;
  let temporaryDirectories;

  beforeEach(() => {
    temporaryDirectories = [];
  });

  function makeTemporaryDirectory(name) {
    const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    temporaryDirectories.push(directoryPath);
    return directoryPath;
  }

  afterEach(() => {
    directory?.destroy();
    for (const directoryPath of temporaryDirectories) {
      fs.rmSync(directoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("adopts a repository that did not exist when the directory was built", async () => {
    const directoryPath = makeTemporaryDirectory("late-repository");
    directory = createDirectory(directoryPath, null);
    expect(directory.status).toBeNull();

    const repository = repositoryFor({
      directoryStatusSummary: { source: "cache", conflicted: false, modified: true, added: false },
    });
    lumine.repositories.getForPath.and.returnValue(repository);
    const statuses = [];
    directory.onDidStatusChange((status) => statuses.push(status));

    repositoryStatusObserver.repositoriesChanged();
    await new Promise((resolve) => setImmediate(resolve));

    expect(directory.status).toBe("modified");
    expect(statuses).toEqual(["modified"]);

    // The subscription is live, so the repository's later reports land too.
    repository.getDirectoryStatusSummary.and.returnValue(null);
    repository.notifyStatusesChanged();
    await new Promise((resolve) => setImmediate(resolve));

    expect(directory.status).toBeNull();
    expect(statuses).toEqual(["modified", null]);
  });

  it("subscribes once however often repository routing changes", async () => {
    const directoryPath = makeTemporaryDirectory("late-repository-resubscribe");
    const repository = repositoryFor({ directoryStatusSummary: null });
    directory = createDirectory(directoryPath, repository);
    expect(repository.subscriberCount()).toBe(1);

    repositoryStatusObserver.repositoriesChanged();
    repositoryStatusObserver.repositoriesChanged();
    await new Promise((resolve) => setImmediate(resolve));

    expect(repository.subscriberCount()).toBe(1);
  });

  it("shares one repository subscription with every loaded child", () => {
    const directoryPath = makeTemporaryDirectory("shared-repository-subscription");
    fs.writeFileSync(path.join(directoryPath, "first.js"), "");
    fs.writeFileSync(path.join(directoryPath, "second.js"), "");
    const repository = repositoryFor({ directoryStatusSummary: null });

    directory = createDirectory(directoryPath, repository);
    directory.reload();

    expect(directory.entries.size).toBe(2);
    expect(repository.subscriberCount()).toBe(1);
  });

  it("hands the repository to the entries it has already loaded", async () => {
    const directoryPath = makeTemporaryDirectory("late-repository-children");
    const filePath = path.join(directoryPath, "index.js");
    fs.writeFileSync(filePath, "");
    directory = createDirectory(directoryPath, null);
    directory.reload();
    expect(directory.entries.get("index.js").status).toBeNull();

    const repository = repositoryFor({
      pathStatusSummary: { source: "cache", conflicted: false, modified: true, added: false },
    });
    lumine.repositories.getForPath.and.returnValue(repository);

    repositoryStatusObserver.repositoriesChanged();
    await new Promise((resolve) => setImmediate(resolve));

    expect(directory.entries.get("index.js").status).toBe("modified");
  });

  it("invalidates visibility without re-reading children when their repository changes", async () => {
    const originalHideVcsIgnoredFiles = lumine.config.get("tree-view.hideVcsIgnoredFiles");
    const directoryPath = makeTemporaryDirectory("late-repository-ignored");
    const ignoredPath = path.join(directoryPath, "build.log");
    fs.writeFileSync(ignoredPath, "");
    fs.writeFileSync(path.join(directoryPath, "index.js"), "");

    try {
      lumine.config.set("tree-view.hideVcsIgnoredFiles", true);
      directory = createDirectory(directoryPath, null, { isExpanded: true });
      directory.reload();
      expect(Array.from(directory.entries.keys()).sort()).toEqual(["build.log", "index.js"]);

      const repository = repositoryFor({ ignoredPaths: [ignoredPath] });
      lumine.repositories.getForPath.and.returnValue(repository);
      const originalEntries = new Map(directory.entries);
      const removed = [];
      directory.onDidRemoveEntries((entries) => removed.push(...entries));
      const visibilityChanged = jasmine.createSpy("visibility changed");
      directory.onDidChangeVisibility(visibilityChanged);
      spyOn(directory, "reload").and.callThrough();

      repositoryStatusObserver.repositoriesChanged();
      await new Promise((resolve) => setImmediate(resolve));

      expect(Array.from(directory.entries.keys()).sort()).toEqual(["build.log", "index.js"]);
      for (const [name, entry] of originalEntries) {
        expect(directory.entries.get(name)).toBe(entry);
      }
      expect(directory.entries.get("build.log").status).toBe("ignored");
      expect(visibilityChanged).toHaveBeenCalledTimes(1);
      expect(directory.reload).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
    } finally {
      lumine.config.set("tree-view.hideVcsIgnoredFiles", originalHideVcsIgnoredFiles);
    }
  });

  it("invalidates visibility and retains models when a snapshot changes ignored paths", async () => {
    const previous = lumine.config.get("tree-view.hideVcsIgnoredFiles");
    const directoryPath = makeTemporaryDirectory("changed-repository-ignored");
    const ignoredPath = path.join(directoryPath, "build.log");
    fs.writeFileSync(ignoredPath, "");
    fs.writeFileSync(path.join(directoryPath, "index.js"), "");
    const ignoredPaths = [];
    const repository = repositoryFor({ ignoredPaths });
    try {
      lumine.config.set("tree-view.hideVcsIgnoredFiles", true);
      directory = createDirectory(directoryPath, repository, { isExpanded: true });
      directory.reload();
      expect(Array.from(directory.entries.keys()).sort()).toEqual(["build.log", "index.js"]);
      const ignoredEntry = directory.entries.get("build.log");
      const visibilityChanged = jasmine.createSpy("visibility changed");
      directory.onDidChangeVisibility(visibilityChanged);
      spyOn(directory, "reload").and.callThrough();
      ignoredPaths.push(ignoredPath);
      repository.notifyStatusesChanged();
      await conditionPromise(() => visibilityChanged.calls.count() === 1);
      expect(directory.entries.get("build.log")).toBe(ignoredEntry);
      expect(ignoredEntry.status).toBe("ignored");
      ignoredPaths.length = 0;
      repository.notifyStatusesChanged();
      await conditionPromise(() => visibilityChanged.calls.count() === 2);
      expect(directory.entries.get("build.log")).toBe(ignoredEntry);
      expect(ignoredEntry.status).toBeNull();
      expect(directory.reload).not.toHaveBeenCalled();
    } finally {
      lumine.config.set("tree-view.hideVcsIgnoredFiles", previous);
    }
  });
});

describe("TreeView Directory watch lifecycle", () => {
  let directory;
  let directoryPath;

  function abortError() {
    return Object.assign(new Error(`File observation cancelled: ${directoryPath}`), {
      name: "AbortError",
      code: "ABORT_ERR",
      path: directoryPath,
    });
  }

  function createPendingWatcher() {
    let resolveReady;
    let rejectReady;
    const watcher = {
      ready: new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      dispose: jasmine.createSpy("dispose watcher"),
      onDidChange: () => new Disposable(),
      onDidInvalidate: () => new Disposable(),
      onDidError: () => new Disposable(),
    };
    return { watcher, resolveReady, rejectReady };
  }

  beforeEach(() => {
    directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-watch-"));
  });

  afterEach(() => {
    directory?.destroy();
    fs.rmSync(directoryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("silences cancellation when destroyed while its watcher is becoming ready", async () => {
    const { watcher, rejectReady } = createPendingWatcher();
    watcher.dispose.and.callFake(() => rejectReady(abortError()));
    spyOn(lumine.fileWatchClient, "watchDirectory").and.returnValue(watcher);
    spyOn(console, "error");
    directory = createDirectory(directoryPath, repositoryFor());

    const watching = directory.watch();
    await Promise.resolve();
    expect(lumine.fileWatchClient.watchDirectory).toHaveBeenCalledWith(directoryPath, undefined);

    directory.destroy();
    directory = null;
    await watching;

    expect(watcher.dispose).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("silences cancellation from the current watcher and releases it", async () => {
    const { watcher, rejectReady } = createPendingWatcher();
    spyOn(lumine.fileWatchClient, "watchDirectory").and.returnValue(watcher);
    spyOn(console, "error");
    directory = createDirectory(directoryPath, repositoryFor());

    const watching = directory.watch();
    await Promise.resolve();
    rejectReady(abortError());
    await watching;

    expect(watcher.dispose).toHaveBeenCalled();
    expect(directory.watchSubscription).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports a failure from the current watcher and releases it", async () => {
    const { watcher, rejectReady } = createPendingWatcher();
    spyOn(lumine.fileWatchClient, "watchDirectory").and.returnValue(watcher);
    spyOn(console, "error");
    directory = createDirectory(directoryPath, repositoryFor());
    const error = new Error("watch failed");

    const watching = directory.watch();
    await Promise.resolve();
    rejectReady(error);
    await watching;

    expect(watcher.dispose).toHaveBeenCalled();
    expect(directory.watchSubscription).toBeNull();
    expect(console.error).toHaveBeenCalledOnceWith(error);
  });
});
