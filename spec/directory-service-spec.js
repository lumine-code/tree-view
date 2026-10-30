const os = require("os");
const path = require("path");
const { Emitter } = require("lumine");
const fs = require("../lib/fs-compat");
const TreeViewPackage = require("../lib/tree-view-package");

describe("tree-view.directory", () => {
  const directoryPath = path.join(os.tmpdir(), "tree-view-directory-service", "photos");
  const defaults = {
    "tree-view.sortMethod": "default",
    "tree-view.sortByBase": true,
    "tree-view.sortFoldersBeforeFiles": true,
    "tree-view.hideIgnoredNames": false,
    "tree-view.hideVcsIgnoredFiles": false,
  };
  let treeViewPackage;
  let service;
  let entries;
  let matcher;
  let originalSettings;

  function statsFor(kind) {
    return {
      isSymbolicLink: () => kind === "symlink",
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
    };
  }

  function entryForPath(fullPath) {
    return entries.find((entry) => entry.name === path.basename(fullPath));
  }

  function names(files) {
    return files.map((filePath) => path.basename(filePath));
  }

  beforeEach(() => {
    originalSettings = new Map();
    for (const [key, value] of Object.entries(defaults)) {
      originalSettings.set(key, lumine.config.get(key));
      lumine.config.set(key, value);
    }
    entries = [];
    matcher = { matches: jasmine.createSpy("matches").and.returnValue(false) };
    spyOn(lumine.project, "getPaths").and.returnValue([]);
    spyOn(lumine.project, "compileIgnoredNames").and.returnValue(matcher);
    spyOn(lumine.repositories, "getForPath").and.returnValue(null);
    spyOn(fs.promises, "realpath").and.callFake(async (fullPath) => fullPath);
    spyOn(fs.promises, "readdir").and.callFake(async () => entries.map((entry) => entry.name));
    spyOn(fs.promises, "lstat").and.callFake(async (fullPath) => {
      const entry = entryForPath(fullPath);
      if (!entry || entry.missing) throw Object.assign(new Error("Missing"), { code: "ENOENT" });
      return statsFor(entry.symlink ? "symlink" : entry.kind);
    });
    spyOn(fs.promises, "stat").and.callFake(async (fullPath) => {
      const entry = entryForPath(fullPath);
      if (!entry || entry.broken) throw Object.assign(new Error("Missing"), { code: "ENOENT" });
      return statsFor(entry.kind);
    });
    treeViewPackage = new TreeViewPackage();
    treeViewPackage.initialize();
    treeViewPackage.activate();
    spyOn(treeViewPackage, "getTreeViewInstance").and.throwError("Must not construct the tree");
    service = treeViewPackage.provideTreeViewDirectory();
  });

  afterEach(async () => {
    // The service's narrow repository fake must not reach core project teardown.
    lumine.repositories.getForPath.and.callThrough();
    if (treeViewPackage.disposables) await treeViewPackage.deactivate();
    for (const [key, value] of originalSettings) {
      if (value === undefined) lumine.config.unset(key);
      else lumine.config.set(key, value);
    }
  });

  it("lists numeric and copy names in tree order without a project or tree widget", async () => {
    entries = [
      "IMG_3940.png",
      "IMG_3939 - Copy.png",
      "IMG_3939.png",
      "IMG_10.JPG",
      "IMG_2.jpg",
    ].map((name) => ({ name, kind: "file" }));
    const files = await service.listFiles(directoryPath);
    expect(names(files)).toEqual([
      "IMG_2.jpg",
      "IMG_10.JPG",
      "IMG_3939.png",
      "IMG_3939 - Copy.png",
      "IMG_3940.png",
    ]);
    expect(files.every((filePath) => path.isAbsolute(filePath))).toBe(true);
    expect(treeViewPackage.getTreeViewInstance).not.toHaveBeenCalled();
    expect(treeViewPackage.treeView).toBeUndefined();

    lumine.config.set("tree-view.sortByBase", false);
    expect(names(await service.listFiles(directoryPath))).toEqual([
      "IMG_2.jpg",
      "IMG_10.JPG",
      "IMG_3939 - Copy.png",
      "IMG_3939.png",
      "IMG_3940.png",
    ]);
    expect(names(files)[2]).toBe("IMG_3939.png");
  });

  it("uses natural sorting when selected and reads a fresh listing on every call", async () => {
    entries = ["éclair.png", "zebra.png", "a10.png", "a2.png"].map((name) => ({
      name,
      kind: "file",
    }));
    lumine.config.set("tree-view.sortMethod", "natural");
    expect(names(await service.listFiles(directoryPath))).toEqual([
      "a2.png",
      "a10.png",
      "zebra.png",
      "éclair.png",
    ]);
    entries.push({ name: "a3.png", kind: "file" });
    expect(names(await service.listFiles(directoryPath))).toEqual([
      "a2.png",
      "a3.png",
      "a10.png",
      "zebra.png",
      "éclair.png",
    ]);
  });

  it("uses the default tree order when sorting configuration is unavailable", async () => {
    const getConfig = lumine.config.get.bind(lumine.config);
    spyOn(lumine.config, "get").and.callFake((key, ...args) => {
      if (key === "tree-view.sortMethod" || key === "tree-view.sortByBase") return undefined;
      return getConfig(key, ...args);
    });
    entries = ["IMG_3939 - Copy.png", "IMG_3939.png"].map((name) => ({ name, kind: "file" }));
    expect(names(await service.listFiles(directoryPath))).toEqual([
      "IMG_3939.png",
      "IMG_3939 - Copy.png",
    ]);
  });

  it("includes file links and excludes directories, broken links and disappeared files", async () => {
    entries = [
      { name: "folder.png", kind: "directory" },
      { name: "folder-link.png", kind: "directory", symlink: true },
      { name: "file.png", kind: "file" },
      { name: "file-link.png", kind: "file", symlink: true },
      { name: "broken.png", kind: "file", symlink: true, broken: true },
      { name: "missing.png", kind: "file", missing: true },
    ];
    expect(names(await service.listFiles(directoryPath))).toEqual(["file.png", "file-link.png"]);
  });

  it("applies ignored-name and VCS filters only when their settings enable them", async () => {
    entries = ["shown.png", "hidden.png", "vcs.png"].map((name) => ({ name, kind: "file" }));
    matcher.matches.and.callFake((relativePath) => relativePath === "hidden.png");
    lumine.repositories.getForPath.and.returnValue({
      isPathIgnoredCached: (fullPath) => path.basename(fullPath) === "vcs.png",
    });
    expect(names(await service.listFiles(directoryPath))).toEqual([
      "hidden.png",
      "shown.png",
      "vcs.png",
    ]);
    lumine.config.set("tree-view.hideIgnoredNames", true);
    lumine.config.set("tree-view.hideVcsIgnoredFiles", true);
    expect(names(await service.listFiles(directoryPath))).toEqual(["shown.png"]);
  });

  it("matches ignored names relative to the most specific project root", async () => {
    const nestedRoot = path.dirname(directoryPath);
    lumine.project.getPaths.and.returnValue([path.dirname(nestedRoot), nestedRoot]);
    entries = [{ name: "hidden.png", kind: "file" }];
    lumine.config.set("tree-view.hideIgnoredNames", true);
    await service.listFiles(directoryPath);
    expect(matcher.matches).toHaveBeenCalledWith(path.join("photos", "hidden.png"));
  });

  it("anchors ignored names at the directory outside the project", async () => {
    lumine.project.getPaths.and.returnValue([path.join(directoryPath, "unrelated")]);
    entries = [{ name: "hidden.png", kind: "file" }];
    lumine.config.set("tree-view.hideIgnoredNames", true);
    await service.listFiles(directoryPath);
    expect(matcher.matches).toHaveBeenCalledWith("hidden.png");
  });

  it("returns an empty listing when a directory cannot be read", async () => {
    fs.promises.readdir.and.rejectWith(Object.assign(new Error("Missing"), { code: "ENOENT" }));
    expect(await service.listFiles(directoryPath)).toEqual([]);
  });

  it("watches standalone directories nonrecursively and releases only its own observation", async () => {
    const makeWatcher = () => {
      const emitter = new Emitter();
      let resolveReady;
      const watcher = {
        emitter,
        ready: new Promise((resolve) => {
          resolveReady = resolve;
        }),
        arm: () => resolveReady(),
        dispose: jasmine.createSpy("dispose").and.callFake(() => emitter.dispose()),
        onDidChange: (callback) => emitter.on("change", callback),
        onDidInvalidate: (callback) => emitter.on("invalidate", callback),
        onDidError: (callback) => emitter.on("error", callback),
      };
      return watcher;
    };
    const firstWatcher = makeWatcher();
    const secondWatcher = makeWatcher();
    spyOn(lumine.fileWatchClient, "watchDirectory").and.returnValues(firstWatcher, secondWatcher);
    const changed = jasmine.createSpy("changed");
    const secondChanged = jasmine.createSpy("secondChanged");
    const first = service.watchDirectory(directoryPath, changed);
    const second = service.watchDirectory(directoryPath, secondChanged);
    expect(lumine.fileWatchClient.watchDirectory).toHaveBeenCalledWith(directoryPath, {
      recursive: false,
    });
    expect(first.ready).toBe(firstWatcher.ready);
    firstWatcher.arm();
    secondWatcher.arm();
    await Promise.all([first.ready, second.ready]);
    expect(changed).not.toHaveBeenCalled();
    firstWatcher.emitter.emit("change", [{ action: "updated" }]);
    expect(changed).not.toHaveBeenCalled();
    firstWatcher.emitter.emit("change", [{ action: "created" }]);
    firstWatcher.emitter.emit("change", [{ action: "deleted" }]);
    firstWatcher.emitter.emit("invalidate", { reason: "recovery" });
    expect(changed).toHaveBeenCalledTimes(3);
    first.dispose();
    expect(firstWatcher.dispose).toHaveBeenCalledTimes(1);
    expect(secondWatcher.dispose).not.toHaveBeenCalled();
    secondWatcher.emitter.emit("change", [{ action: "created" }]);
    expect(secondChanged).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(secondWatcher.dispose).toHaveBeenCalledTimes(1);
    expect(treeViewPackage.getTreeViewInstance).not.toHaveBeenCalled();
  });

  it("releases a pending directory watch during provider teardown and propagates cancelled readiness", async () => {
    const emitter = new Emitter();
    let rejectReady;
    const cancelled = Object.assign(new Error("Watch disposed"), { code: "ABORT_ERR" });
    const watcher = {
      ready: new Promise((_resolve, reject) => {
        rejectReady = reject;
      }),
      dispose: jasmine.createSpy("dispose").and.callFake(() => {
        rejectReady(cancelled);
        emitter.dispose();
      }),
      onDidChange: (callback) => emitter.on("change", callback),
      onDidInvalidate: (callback) => emitter.on("invalidate", callback),
      onDidError: (callback) => emitter.on("error", callback),
    };
    spyOn(lumine.fileWatchClient, "watchDirectory").and.returnValue(watcher);
    const handle = service.watchDirectory(directoryPath, jasmine.createSpy("changed"));
    const rejection = expectAsync(handle.ready).toBeRejectedWith(cancelled);
    await treeViewPackage.deactivate();
    await rejection;
    expect(watcher.dispose).toHaveBeenCalledTimes(1);
    handle.dispose();
    expect(watcher.dispose).toHaveBeenCalledTimes(1);
  });

  it("invalidates on every sorting and visibility setting and disposes the edge subscription", () => {
    const callback = jasmine.createSpy("changed");
    const lease = service.onDidChange(callback);
    const changedSettings = {
      "tree-view.sortMethod": "natural",
      "tree-view.sortByBase": false,
      "tree-view.sortFoldersBeforeFiles": false,
      "tree-view.hideIgnoredNames": true,
      "tree-view.hideVcsIgnoredFiles": true,
      "core.ignoredNames": ["service-test-hidden"],
    };
    const ignoredNames = lumine.config.get("core.ignoredNames");
    try {
      for (const [key, value] of Object.entries(changedSettings)) {
        callback.calls.reset();
        lumine.config.set(key, value);
        expect(callback).toHaveBeenCalledTimes(1);
      }
      lease.dispose();
      callback.calls.reset();
      lumine.config.set("tree-view.sortByBase", true);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      lumine.config.set("core.ignoredNames", ignoredNames);
    }
  });

  it("tracks project and repository invalidation and releases subscriptions on provider teardown", async () => {
    const emitter = new Emitter();
    const repository = {
      onDidChangeStatusSnapshot: (callback) => emitter.on("snapshot", callback),
    };
    let repositories = [repository];
    spyOn(lumine.repositories, "getRepositories").and.callFake(() => repositories);
    spyOn(lumine.repositories, "onDidChange").and.callFake((callback) =>
      emitter.on("registry", callback),
    );
    spyOn(lumine.project, "onDidChangePaths").and.callFake((callback) =>
      emitter.on("paths", callback),
    );
    spyOn(lumine.project, "onDidInvalidateFiles").and.callFake((callback) =>
      emitter.on("project-invalidation", callback),
    );
    const callback = jasmine.createSpy("changed");
    service.onDidChange(callback);
    expect(callback).not.toHaveBeenCalled();
    emitter.emit("snapshot");
    expect(callback).not.toHaveBeenCalled();
    lumine.config.set("tree-view.hideVcsIgnoredFiles", true);
    callback.calls.reset();
    emitter.emit("snapshot");
    emitter.emit("paths");
    emitter.emit("project-invalidation", { rootPaths: [directoryPath] });
    expect(callback).toHaveBeenCalledTimes(3);
    repositories = [];
    emitter.emit("registry");
    callback.calls.reset();
    emitter.emit("snapshot");
    expect(callback).not.toHaveBeenCalled();
    await treeViewPackage.deactivate();
    callback.calls.reset();
    emitter.emit("paths");
    emitter.emit("project-invalidation", { rootPaths: [directoryPath] });
    emitter.emit("registry");
    expect(callback).not.toHaveBeenCalled();
    lumine.repositories.getRepositories.and.callThrough();
    lumine.repositories.onDidChange.and.callThrough();
    lumine.project.onDidChangePaths.and.callThrough();
    lumine.project.onDidInvalidateFiles.and.callThrough();
    emitter.dispose();
  });
});

describe("TreeView sorting policy refresh", () => {
  it("refreshes the visible tree when the sort method or base-name policy changes", async () => {
    const previousMethod = lumine.config.get("tree-view.sortMethod");
    const previousBase = lumine.config.get("tree-view.sortByBase");
    const treeViewPackage = new TreeViewPackage();
    treeViewPackage.initialize();
    treeViewPackage.activate();
    const tree = treeViewPackage.getTreeViewInstance();
    spyOn(tree, "updateRoots");
    try {
      lumine.config.set(
        "tree-view.sortMethod",
        previousMethod === "natural" ? "default" : "natural",
      );
      expect(tree.updateRoots).toHaveBeenCalledTimes(1);
      lumine.config.set("tree-view.sortByBase", !previousBase);
      expect(tree.updateRoots).toHaveBeenCalledTimes(2);
    } finally {
      await treeViewPackage.deactivate();
      if (previousMethod === undefined) lumine.config.unset("tree-view.sortMethod");
      else lumine.config.set("tree-view.sortMethod", previousMethod);
      if (previousBase === undefined) lumine.config.unset("tree-view.sortByBase");
      else lumine.config.set("tree-view.sortByBase", previousBase);
    }
  });
});
