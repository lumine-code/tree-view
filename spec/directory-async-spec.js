const os = require("os");
const path = require("path");
const { Disposable } = require("lumine");
const Directory = require("../lib/directory");
const fs = require("../lib/fs-compat");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function statsFor(kind, size = 123) {
  return {
    size,
    atime: new Date(0),
    birthtime: new Date(1700000000001),
    ctime: new Date(1700000000002),
    mtime: new Date(1700000000003),
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

describe("TreeView Directory asynchronous initial loading", () => {
  let directory;
  let entries;
  let pendingGates;
  let watcherReady;
  let watcher;
  let originalSettings;
  let nativePromises;
  const directoryPath = path.join(os.tmpdir(), "tree-view-mocked-async");
  const settings = {
    "tree-view.sortMethod": "default",
    "tree-view.sortByBase": true,
    "tree-view.sortFoldersBeforeFiles": true,
    "tree-view.squashDirectoryNames": false,
    "tree-view.hideIgnoredNames": false,
    "tree-view.hideVcsIgnoredFiles": false,
  };

  function gate(fallback = []) {
    let resolvePromise;
    let rejectPromise;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending = {
      promise,
      resolve(value = fallback) {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      },
      reject(error) {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
    };
    pendingGates.push(pending);
    return pending;
  }

  function entryForPath(fullPath) {
    return entries.find((entry) => entry.name === path.basename(fullPath));
  }

  function isFixturePath(fullPath) {
    return (
      typeof fullPath === "string" &&
      (fullPath === directoryPath || fullPath.startsWith(directoryPath + path.sep))
    );
  }

  function mockAsync(method, implementation) {
    // fs-compat exposes Node's shared promises object. Restrict these mocks
    // to the fixture so background editor reads retain their real behavior.
    fs.promises[method].and.callFake((fullPath, ...args) => {
      if (isFixturePath(fullPath)) {
        return implementation(fullPath, ...args);
      }
      return nativePromises[method](fullPath, ...args);
    });
  }

  function asyncCallCount(method) {
    return fs.promises[method].calls.allArgs().filter(([fullPath]) => isFixturePath(fullPath))
      .length;
  }

  function createDirectory({ useSyncFS = false, ignoredNames = { matches: () => false } } = {}) {
    return new Directory({
      name: "mocked-async",
      fullPath: directoryPath,
      isRoot: true,
      ignoredNames,
      useSyncFS,
    });
  }

  beforeEach(() => {
    entries = [{ name: "first.txt", kind: "file" }];
    pendingGates = [];
    originalSettings = new Map();
    for (const [key, value] of Object.entries(settings)) {
      originalSettings.set(key, lumine.config.get(key));
      lumine.config.set(key, value);
    }
    spyOn(lumine.repositories, "getForPath").and.returnValue(null);
    spyOn(fs, "isCaseInsensitive").and.returnValue(process.platform === "win32");
    spyOn(fs, "realpath").and.callFake((fullPath, callback) => callback(null, fullPath));
    spyOn(fs, "realpathSync").and.callFake((fullPath) => fullPath);
    spyOn(fs, "existsSync").and.returnValue(true);
    spyOn(fs, "readdirSync").and.callFake(() => entries.map((entry) => entry.name));
    spyOn(fs, "lstatSyncNoException").and.callFake((fullPath) => {
      const entry = entryForPath(fullPath);
      return entry ? statsFor(entry.symlink ? "symlink" : entry.kind) : false;
    });
    spyOn(fs, "statSyncNoException").and.callFake((fullPath) => {
      const entry = entryForPath(fullPath);
      return entry ? statsFor(entry.kind) : false;
    });
    nativePromises = Object.fromEntries(
      ["readdir", "lstat", "stat", "realpath"].map((method) => [method, fs.promises[method]]),
    );
    for (const method of Object.keys(nativePromises)) spyOn(fs.promises, method);
    mockAsync("readdir", async () => entries.map((entry) => entry.name));
    mockAsync("lstat", async (fullPath) => {
      const entry = entryForPath(fullPath);
      if (!entry) throw Object.assign(new Error("Entry disappeared"), { code: "ENOENT" });
      return statsFor(entry.symlink ? "symlink" : entry.kind);
    });
    mockAsync("stat", async (fullPath) => {
      const entry = entryForPath(fullPath);
      if (!entry) throw Object.assign(new Error("Target disappeared"), { code: "ENOENT" });
      return statsFor(entry.kind);
    });
    mockAsync("realpath", async (fullPath) => fullPath);
    watcherReady = gate(undefined);
    watcher = {
      ready: watcherReady.promise,
      dispose: jasmine.createSpy("dispose watcher"),
      onDidChange: () => new Disposable(),
      onDidInvalidate: () => new Disposable(),
      onDidError: () => new Disposable(),
    };
    spyOn(lumine.fileWatchClient, "watchDirectory").and.returnValue(watcher);
    directory = createDirectory();
  });

  afterEach(async () => {
    directory.destroy();
    for (const pending of pendingGates) pending.resolve();
    await nextTurn();
    for (const [key, value] of originalSettings) {
      if (value === undefined) lumine.config.unset(key);
      else lumine.config.set(key, value);
    }
  });

  it("shares an expansion and publishes children before its watcher is ready", async () => {
    const read = gate();
    mockAsync("readdir", () => read.promise);
    const expanded = jasmine.createSpy("expanded");
    directory.onDidExpand(expanded);

    const firstExpansion = directory.expand();
    const secondExpansion = directory.expand();
    const settled = jasmine.createSpy("expansion settled");
    firstExpansion.then(settled);
    expect(secondExpansion).toBe(firstExpansion);
    expect(directory.entries.size).toBe(0);
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.lstatSyncNoException).not.toHaveBeenCalled();

    read.resolve(["first.txt"]);
    await directory.entriesLoadedPromise;
    await nextTurn();

    expect(Array.from(directory.entries.keys())).toEqual(["first.txt"]);
    expect(asyncCallCount("readdir")).toBe(1);
    expect(lumine.fileWatchClient.watchDirectory.calls.count()).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    expect(expanded).not.toHaveBeenCalled();

    watcherReady.resolve();
    await firstExpansion;

    expect(settled).toHaveBeenCalled();
    expect(expanded).toHaveBeenCalledTimes(1);
  });

  for (const phase of ["readdir", "lstat"]) {
    for (const action of ["unwatch", "collapse", "destroy"]) {
      it(`settles ${action} while ${phase} is pending without publishing stale entries`, async () => {
        const pending = gate(phase === "readdir" ? [] : statsFor("file"));
        mockAsync(phase, () => pending.promise);
        const added = jasmine.createSpy("added entries");
        const expanded = jasmine.createSpy("expanded");
        directory.onDidAddEntries(added);
        directory.onDidExpand(expanded);
        const expansion = directory.expand();
        const settled = jasmine.createSpy("cancelled expansion settled");
        expansion.then(settled);
        await nextTurn();
        expect(asyncCallCount(phase)).toBeGreaterThan(0);

        directory[action]();
        await flushMicrotasks();
        expect(settled).toHaveBeenCalled();

        pending.resolve(phase === "readdir" ? ["first.txt"] : statsFor("file"));
        watcherReady.resolve();
        await expansion;
        await nextTurn();

        expect(directory.entries.size).toBe(0);
        expect(added).not.toHaveBeenCalled();
        expect(expanded).not.toHaveBeenCalled();
        expect(lumine.fileWatchClient.watchDirectory).not.toHaveBeenCalled();
      });
    }
  }

  for (const action of ["unwatch", "collapse", "destroy"]) {
    it(`settles ${action} after children load while watcher readiness remains pending`, async () => {
      const expanded = jasmine.createSpy("expanded");
      directory.onDidExpand(expanded);
      const expansion = directory.expand();
      const settled = jasmine.createSpy("watching expansion settled");
      expansion.then(settled);
      await directory.entriesLoadedPromise;
      await nextTurn();
      const model = directory.entries.get("first.txt");
      expect(model).toBeDefined();
      expect(lumine.fileWatchClient.watchDirectory).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();

      directory[action]();
      await flushMicrotasks();

      // The fake watcher does not resolve or reject ready on disposal. The
      // expansion itself must settle without depending on native readiness.
      expect(settled).toHaveBeenCalled();
      expect(watcher.dispose).toHaveBeenCalledTimes(1);
      expect(model.destroyed).toBe(true);
      expect(directory.entries.size).toBe(0);
      expect(expanded).not.toHaveBeenCalled();

      watcherReady.resolve();
      await expansion;
      await nextTurn();
      expect(expanded).not.toHaveBeenCalled();
      expect(directory.entries.size).toBe(0);
    });
  }

  it("settles collapse while the realpath preceding watcher creation is pending", async () => {
    const realpath = gate(undefined);
    let resolutionCount = 0;
    spyOn(directory, "loadRealPathPromise").and.callFake(() => {
      resolutionCount++;
      return resolutionCount === 1 ? Promise.resolve() : realpath.promise;
    });
    const expanded = jasmine.createSpy("expanded");
    directory.onDidExpand(expanded);
    const expansion = directory.expand();
    const settled = jasmine.createSpy("realpath expansion settled");
    expansion.then(settled);
    await directory.entriesLoadedPromise;
    await nextTurn();
    expect(resolutionCount).toBe(2);
    expect(lumine.fileWatchClient.watchDirectory).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();

    directory.collapse();
    await flushMicrotasks();
    expect(settled).toHaveBeenCalled();
    expect(directory.entries.size).toBe(0);

    realpath.resolve();
    await expansion;
    await nextTurn();
    expect(lumine.fileWatchClient.watchDirectory).not.toHaveBeenCalled();
    expect(expanded).not.toHaveBeenCalled();
  });

  for (const action of ["collapse", "destroy"]) {
    it(`destroys every published model when ${action} occurs in an add handler`, async () => {
      entries = Array.from({ length: 600 }, (_, index) => ({
        name: `file-${String(index).padStart(3, "0")}.txt`,
        kind: "file",
      }));
      const publications = [];
      const expanded = jasmine.createSpy("expanded");
      directory.onDidExpand(expanded);
      directory.onDidAddEntries((models) => {
        publications.push(models);
        if (publications.length === 1) directory[action]();
      });

      await directory.expand();
      await nextTurn();

      expect(publications.length).toBe(1);
      expect(publications[0].length).toBe(entries.length);
      for (const model of publications[0]) expect(model.destroyed).toBe(true);
      expect(directory.entries.size).toBe(0);
      expect(lumine.fileWatchClient.watchDirectory).not.toHaveBeenCalled();
      expect(expanded).not.toHaveBeenCalled();
    });
  }

  it("keeps a re-expansion authoritative when the cancelled read finishes last", async () => {
    const firstRead = gate();
    const secondRead = gate();
    const reads = [firstRead.promise, secondRead.promise];
    mockAsync("readdir", () => reads.shift());
    const expanded = jasmine.createSpy("expanded");
    directory.onDidExpand(expanded);
    const firstExpansion = directory.expand();
    await nextTurn();
    directory.collapse();

    entries = [{ name: "fresh.txt", kind: "file" }];
    const secondExpansion = directory.expand();
    const secondSettled = jasmine.createSpy("second expansion settled");
    secondExpansion.then(secondSettled);
    secondRead.resolve(["fresh.txt"]);
    await directory.entriesLoadedPromise;
    await nextTurn();
    firstRead.resolve(["stale.txt"]);
    await firstExpansion;
    await nextTurn();

    expect(Array.from(directory.entries.keys())).toEqual(["fresh.txt"]);
    expect(secondSettled).not.toHaveBeenCalled();
    watcherReady.resolve();
    await secondExpansion;
    expect(expanded).toHaveBeenCalledTimes(1);
    expect(lumine.fileWatchClient.watchDirectory).toHaveBeenCalledTimes(1);
  });

  it("keeps a synchronous reload authoritative over an older asynchronous scan", async () => {
    const read = gate();
    mockAsync("readdir", () => read.promise);
    const expansion = directory.expand();
    await nextTurn();

    entries = [{ name: "fresh.txt", kind: "file" }];
    directory.reload();
    const freshModel = directory.entries.get("fresh.txt");
    expect(freshModel).toBeDefined();
    expect(directory.getEntries()).toEqual(["fresh.txt"]);

    read.resolve(["stale.txt"]);
    watcherReady.resolve();
    await expansion;
    await nextTurn();

    expect(Array.from(directory.entries.keys())).toEqual(["fresh.txt"]);
    expect(directory.entries.get("fresh.txt")).toBe(freshModel);
    expect(freshModel.destroyed).toBe(false);
  });

  it("coalesces overlapping refreshes into a final rescan with the latest entries", async () => {
    const firstRead = gate();
    const latestRead = gate();
    const reads = [firstRead.promise, latestRead.promise];
    mockAsync("readdir", () => reads.shift());
    const firstLoading = directory.reloadAsync();
    const firstSettled = jasmine.createSpy("rescan settled");
    firstLoading.then(firstSettled);
    await nextTurn();

    entries = [
      { name: "outdated.txt", kind: "file" },
      { name: "latest.txt", kind: "file" },
    ];
    const latestLoading = directory.reloadAsync({ rescan: true });
    const overlappingLoading = directory.reloadAsync({ rescan: true });
    expect(latestLoading).toBe(firstLoading);
    expect(overlappingLoading).toBe(firstLoading);
    await flushMicrotasks();
    expect(asyncCallCount("readdir")).toBe(1);
    expect(firstSettled).not.toHaveBeenCalled();

    firstRead.resolve(["outdated.txt"]);
    await nextTurn();
    expect(asyncCallCount("readdir")).toBe(2);
    expect(firstSettled).not.toHaveBeenCalled();
    latestRead.resolve(["latest.txt"]);
    await latestLoading;
    const latestModel = directory.entries.get("latest.txt");

    await firstLoading;
    await nextTurn();
    expect(asyncCallCount("readdir")).toBe(2);
    expect(Array.from(directory.entries.keys())).toEqual(["latest.txt"]);
    expect(directory.entries.get("latest.txt")).toBe(latestModel);
  });

  it("starts a fresh rescan queued by the final publication before the first promise settles", async () => {
    let queuedRefresh;
    directory.onDidAddEntries(() => {
      if (queuedRefresh) return;
      queuedRefresh = Promise.resolve().then(() => {
        entries.push({ name: "added-after-publication.txt", kind: "file" });
        return directory.reloadAsync({ rescan: true });
      });
    });

    await directory.reloadAsync();
    expect(queuedRefresh).toBeDefined();
    await queuedRefresh;

    expect(asyncCallCount("readdir")).toBe(2);
    expect(directory.entries.get("first.txt")).toBeDefined();
    expect(directory.entries.get("added-after-publication.txt")).toBeDefined();
    expect(directory.getEntries()).toEqual(["added-after-publication.txt", "first.txt"]);
  });

  it("preserves sorted order despite out-of-order stats and skips disappearing symlink targets", async () => {
    entries = [
      { name: "a10.js", kind: "file" },
      { name: "z-directory", kind: "directory" },
      { name: "a2.js", kind: "file" },
      { name: "folder-link", kind: "directory", symlink: true },
      { name: "broken-link", kind: "file", symlink: true },
      { name: "missing.txt", kind: "file" },
    ];
    const statGates = new Map(entries.map((entry) => [entry.name, gate(statsFor(entry.kind))]));
    mockAsync("lstat", (fullPath) => statGates.get(path.basename(fullPath)).promise);
    mockAsync("stat", async (fullPath) => {
      if (path.basename(fullPath) === "broken-link") {
        throw Object.assign(new Error("Symlink target disappeared"), { code: "ENOENT" });
      }
      return statsFor("directory", 456);
    });
    const targetPath = path.join(directoryPath, "target-directory");
    mockAsync("realpath", async (fullPath) =>
      path.basename(fullPath) === "folder-link" ? targetPath : fullPath,
    );
    const added = [];
    directory.onDidAddEntries((models) => added.push(...models));
    const loading = directory.reloadAsync();
    await nextTurn();
    expect(added).toEqual([]);

    let completedStats = 0;
    for (const entry of entries.slice().reverse()) {
      const statGate = statGates.get(entry.name);
      if (entry.name === "missing.txt") {
        statGate.reject(Object.assign(new Error("Entry disappeared"), { code: "ENOENT" }));
      } else {
        statGate.resolve(statsFor(entry.symlink ? "symlink" : entry.kind));
      }
      await flushMicrotasks();
      completedStats++;
      if (completedStats < entries.length) expect(added).toEqual([]);
    }
    await loading;

    expect(added.map((entry) => entry.name)).toEqual([
      "folder-link",
      "z-directory",
      "a2.js",
      "a10.js",
    ]);
    for (const [index, entry] of added.entries()) {
      expect(entry.indexInParentDirectory).toBe(index);
    }
    const symlink = directory.entries.get("folder-link");
    expect(symlink.symlink).toBe(true);
    expect(symlink.realPath).toBe(targetPath);
    expect(symlink.stats.size).toBe(456);
    expect(symlink.stats.mtime).toBe(1700000000003);
  });

  it("bounds parallel stat requests while allowing more than one to make progress", async () => {
    entries = Array.from({ length: 40 }, (_, index) => ({
      name: `file-${index}.txt`,
      kind: "file",
    }));
    const outstanding = [];
    let active = 0;
    let maximumActive = 0;
    mockAsync("lstat", () => {
      const request = gate(statsFor("file"));
      outstanding.push(request);
      active++;
      maximumActive = Math.max(maximumActive, active);
      return request.promise.then((stat) => {
        active--;
        return stat;
      });
    });
    const loading = directory.reloadAsync();
    const settled = jasmine.createSpy("stat scan settled");
    loading.then(settled);
    await nextTurn();

    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(16);
    expect(asyncCallCount("lstat")).toBeLessThan(entries.length);
    for (let round = 0; round <= entries.length && !settled.calls.any(); round++) {
      for (const request of outstanding.splice(0)) request.resolve(statsFor("file"));
      await nextTurn();
    }
    expect(settled).toHaveBeenCalled();
    await loading;

    expect(maximumActive).toBeLessThanOrEqual(16);
    expect(directory.entries.size).toBe(entries.length);
  });

  it("publishes one complete sorted listing and retains unchanged models on rescan", async () => {
    entries = Array.from({ length: 600 }, (_, index) => ({
      name: `file-${String(index).padStart(3, "0")}.txt`,
      kind: "file",
    }));
    const publications = [];
    const removed = [];
    directory.onDidAddEntries((models) => publications.push(models));
    directory.onDidRemoveEntries((models) => removed.push(models));
    await directory.reloadAsync();
    expect(publications.length).toBe(1);
    expect(publications[0].map((model) => model.name)).toEqual(entries.map((entry) => entry.name));
    for (const [index, model] of publications[0].entries()) {
      expect(model.indexInParentDirectory).toBe(index);
    }
    const originalModels = new Map(directory.entries);

    publications.length = 0;
    await directory.reloadAsync({ rescan: true });
    expect(publications).toEqual([]);
    expect(removed).toEqual([]);
    for (const [name, model] of originalModels) {
      expect(directory.entries.get(name)).toBe(model);
    }

    const removedName = entries[0].name;
    entries = entries.slice(1).concat({ name: "new.txt", kind: "file" });
    await directory.reloadAsync({ rescan: true });
    const newModel = directory.entries.get("new.txt");
    expect(publications).toEqual([[newModel]]);
    expect(removed).toEqual([new Set([originalModels.get(removedName)])]);
    expect(originalModels.get(removedName).destroyed).toBe(true);
    expect(newModel.indexInParentDirectory).toBe(entries.length - 1);
    for (const [name, model] of originalModels) {
      if (name !== removedName) expect(directory.entries.get(name)).toBe(model);
    }
  });

  it("uses one settings snapshot per scan and applies changed settings on the next rescan", async () => {
    directory.destroy();
    directory = createDirectory({
      ignoredNames: { matches: (fullPath) => path.basename(fullPath) === "ignored.tmp" },
    });
    entries = [
      { name: "a-file.txt", kind: "file" },
      { name: "z-directory", kind: "directory" },
      { name: "ignored.tmp", kind: "file" },
    ];
    lumine.config.set("tree-view.hideIgnoredNames", true);
    const read = gate();
    mockAsync("readdir", () => read.promise);
    const loading = directory.reloadAsync();
    await nextTurn();

    lumine.config.set("tree-view.hideIgnoredNames", false);
    lumine.config.set("tree-view.sortFoldersBeforeFiles", false);
    read.resolve(entries.map((entry) => entry.name));
    await loading;
    expect(Array.from(directory.entries.keys())).toEqual(["z-directory", "a-file.txt"]);

    await directory.reloadAsync({ rescan: true });
    expect(directory.getEntries()).toEqual(["a-file.txt", "ignored.tmp", "z-directory"]);
    expect(directory.entries.get("ignored.tmp").ignoredByName).toBe(true);
  });

  it("refreshes retained squashed directories and symlinks without preparing their paths again", async () => {
    lumine.config.set("tree-view.squashDirectoryNames", true);
    entries = [
      { name: "squashed", kind: "directory" },
      { name: "file-link", kind: "file", symlink: true },
    ];
    const squashedPath = path.join(directoryPath, "squashed");
    const nestedPath = path.join(squashedPath, "nested");
    const canonicalDirectoryPath = path.join(directoryPath, "canonical-directory");
    const canonicalFilePath = path.join(directoryPath, "canonical-file.txt");
    mockAsync("readdir", async (fullPath) => {
      if (fullPath === directoryPath) return entries.map((entry) => entry.name);
      if (fullPath === squashedPath) return ["nested"];
      if (fullPath === nestedPath) return ["first.txt", "second.txt"];
      throw new Error(`Unexpected directory read: ${fullPath}`);
    });
    mockAsync("stat", async (fullPath) => statsFor(fullPath === nestedPath ? "directory" : "file"));
    mockAsync("realpath", async (fullPath) =>
      fullPath === nestedPath ? canonicalDirectoryPath : canonicalFilePath,
    );

    await directory.reloadAsync();
    const squashed = directory.entries.get("squashed");
    const symlink = directory.entries.get("file-link");
    expect(squashed.path).toBe(nestedPath);
    expect(squashed.realPath).toBe(canonicalDirectoryPath);
    expect(squashed.squashedNames).toEqual(["squashed" + path.sep, "nested"]);
    expect(symlink.realPath).toBe(canonicalFilePath);
    for (const method of Object.keys(nativePromises)) fs.promises[method].calls.reset();

    await directory.reloadAsync({ rescan: true });

    expect(directory.entries.get("squashed")).toBe(squashed);
    expect(directory.entries.get("file-link")).toBe(symlink);
    expect(squashed.path).toBe(nestedPath);
    expect(squashed.realPath).toBe(canonicalDirectoryPath);
    expect(symlink.realPath).toBe(canonicalFilePath);
    const directoryReads = fs.promises.readdir.calls
      .allArgs()
      .filter(([fullPath]) => isFixturePath(fullPath));
    expect(directoryReads.map(([fullPath]) => fullPath)).toEqual([directoryPath]);
    expect(asyncCallCount("lstat")).toBe(2);
    expect(asyncCallCount("stat")).toBe(1);
    expect(asyncCallCount("realpath")).toBe(0);

    mockAsync("stat", async () => {
      throw Object.assign(new Error("Retained symlink target disappeared"), { code: "ENOENT" });
    });
    await directory.reloadAsync({ rescan: true });
    expect(directory.entries.get("squashed")).toBe(squashed);
    expect(directory.entries.has("file-link")).toBe(false);
    expect(symlink.destroyed).toBe(true);
  });

  it("keeps getEntries and reload synchronous when useSyncFS is false", () => {
    directory.reload();

    expect(directory.entries.get("first.txt")).toBeDefined();
    expect(directory.getEntries()).toEqual(["first.txt"]);
    expect(fs.readdirSync).toHaveBeenCalled();
    expect(fs.lstatSyncNoException).toHaveBeenCalled();
    expect(asyncCallCount("readdir")).toBe(0);
    expect(asyncCallCount("lstat")).toBe(0);
  });

  it("keeps immediate child creation during expand when useSyncFS is true", async () => {
    directory.destroy();
    directory = createDirectory({ useSyncFS: true });
    const expansion = directory.expand();

    expect(directory.entries.get("first.txt")).toBeDefined();
    expect(fs.readdirSync).toHaveBeenCalled();
    expect(asyncCallCount("readdir")).toBe(0);
    watcherReady.resolve();
    await expansion;
  });
});
