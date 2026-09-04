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
} = {}) {
  const statusesCallbacks = [];
  return {
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
      return null;
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

  it("re-reads the entries when the new repository ignores one of them", async () => {
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
      const removed = [];
      directory.onDidRemoveEntries((entries) => removed.push(...entries));

      repositoryStatusObserver.repositoriesChanged();
      await new Promise((resolve) => setImmediate(resolve));

      expect(Array.from(directory.entries.keys())).toEqual(["index.js"]);
      expect(removed.map((entry) => entry.name)).toEqual(["build.log"]);
    } finally {
      lumine.config.set("tree-view.hideVcsIgnoredFiles", originalHideVcsIgnoredFiles);
    }
  });
});
