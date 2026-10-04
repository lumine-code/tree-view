const fs = require("fs");
const os = require("os");
const path = require("path");
const Directory = require("../lib/directory");
const TreeView = require("../lib/tree-view");

describe("TreeView restoring expanded descendants", () => {
  let originalProjectPaths;
  let originalSettings;
  let temporaryPath;
  let projectPath;
  let otherProjectPath;
  let treeView;
  let gates;
  let operations;
  const settings = {
    "tree-view.squashDirectoryNames": false,
    "tree-view.hideIgnoredNames": false,
    "tree-view.hideVcsIgnoredFiles": false,
    "tree-view.autoReveal": false,
    "tree-view.stickyHeaders": "none",
  };

  beforeEach(async () => {
    originalProjectPaths = lumine.project.getPaths();
    originalSettings = {};
    for (const [key, value] of Object.entries(settings)) {
      originalSettings[key] = lumine.config.get(key);
      lumine.config.set(key, value);
    }
    gates = [];
    operations = [];
    temporaryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-restore-")));
    projectPath = path.join(temporaryPath, "project");
    otherProjectPath = path.join(temporaryPath, "other");
    for (const directory of ["A/B/C", "A/S", "A/closed"]) {
      fs.mkdirSync(fullPath(directory), { recursive: true });
    }
    for (const filename of [
      "A/B/one.txt",
      "A/B/two.txt",
      "A/B/C/deep.txt",
      "A/S/sibling.txt",
      "A/closed/hidden.txt",
    ]) {
      fs.writeFileSync(fullPath(filename), filename);
    }
    fs.mkdirSync(otherProjectPath);
    fs.writeFileSync(path.join(otherProjectPath, "other.txt"), "other");
    lumine.project.setPaths([projectPath, otherProjectPath]);
    treeView = new TreeView({
      directoryExpansionStates: {
        [projectPath]: { isExpanded: false },
        [otherProjectPath]: { isExpanded: false },
      },
    });
    await expand(projectPath);
  });

  afterEach(async () => {
    for (const pending of gates) pending.resolve();
    await Promise.allSettled(operations);
    await treeView?.destroy();
    lumine.project.setPaths(originalProjectPaths);
    for (const [key, value] of Object.entries(originalSettings)) lumine.config.set(key, value);
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(temporaryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function fullPath(relativePath) {
    return path.join(projectPath, ...relativePath.split("/"));
  }

  function gate() {
    let resolve;
    const promise = new Promise((callback) => {
      resolve = callback;
    });
    const pending = { promise, resolve, started: false, directory: null, loading: null };
    gates.push(pending);
    return pending;
  }

  function track(promise) {
    operations.push(promise);
    return promise;
  }

  async function expand(entryPath) {
    const entry = treeView.treeEntryForPath(entryPath);
    await track(entry.expand());
    await entry.entriesLoadedPromise;
    return entry;
  }

  async function prepareExpandedTree(relativePaths) {
    const parent = await expand(fullPath("A"));
    for (const relativePath of relativePaths) await expand(fullPath(relativePath));
    const expandedRows = visiblePaths();
    parent.collapse();
    return { parent, expandedRows, collapsedRows: visiblePaths() };
  }

  function visiblePaths() {
    return treeView.visibleRows.map((entry) => entry.getPath());
  }

  function mountedPaths() {
    return Array.from(treeView.list.querySelectorAll(".tree-view-row"), (row) =>
      row.treeEntry.getPath(),
    );
  }

  function holdDirectoryLoads(delayedPaths) {
    const reloadAsync = Directory.prototype.reloadAsync;
    const readPaths = [];
    spyOn(Directory.prototype, "reloadAsync").and.callFake(function (options) {
      readPaths.push(this.path);
      const pending = delayedPaths.get(this.path)?.shift();
      if (!pending) return reloadAsync.call(this, options);
      pending.started = true;
      pending.directory = this;
      pending.loading = pending.promise.then(() => reloadAsync.call(this, options));
      return pending.loading;
    });
    return readPaths;
  }

  function observePresentation() {
    const snapshots = [];
    const renderVisibleRows = treeView.renderVisibleRows;
    spyOn(treeView, "rebuildVisibleRows").and.callThrough();
    spyOn(treeView, "renderVisibleRows").and.callFake(function () {
      renderVisibleRows.call(this);
      snapshots.push(mountedPaths());
    });
    return snapshots;
  }

  it("publishes A, remembered-open B and its files in one update", async () => {
    const { parent, expandedRows, collapsedRows } = await prepareExpandedTree(["A/B"]);
    const childLoad = gate();
    const readPaths = holdDirectoryLoads(new Map([[fullPath("A/B"), [childLoad]]]));
    const snapshots = observePresentation();

    const reopening = track(parent.expand());
    await conditionPromise(() => childLoad.started, "remembered B load started");

    expect(visiblePaths()).toEqual(collapsedRows);
    expect(mountedPaths()).toEqual(collapsedRows);
    expect(treeView.rebuildVisibleRows).not.toHaveBeenCalled();
    expect(readPaths).not.toContain(fullPath("A/closed"));
    expect(readPaths).not.toContain(fullPath("A/B/C"));

    childLoad.resolve();
    await parent.entriesLoadedPromise;
    await reopening;
    await conditionPromise(() => visiblePaths().includes(fullPath("A/B/two.txt")));
    await flushMicrotasks();

    expect(visiblePaths()).toEqual(expandedRows);
    expect(mountedPaths()).toEqual(expandedRows);
    expect(snapshots).toEqual([expandedRows]);
    expect(treeView.rebuildVisibleRows).toHaveBeenCalledTimes(1);
    expect(readPaths).not.toContain(fullPath("A/closed"));
    expect(readPaths).not.toContain(fullPath("A/B/C"));
  });

  it("waits for both deeper and sibling remembered-open directories before publishing", async () => {
    const { parent, expandedRows, collapsedRows } = await prepareExpandedTree([
      "A/B",
      "A/B/C",
      "A/S",
    ]);
    const deepLoad = gate();
    const siblingLoad = gate();
    holdDirectoryLoads(
      new Map([
        [fullPath("A/B/C"), [deepLoad]],
        [fullPath("A/S"), [siblingLoad]],
      ]),
    );
    const snapshots = observePresentation();

    const reopening = track(parent.expand());
    await conditionPromise(() => deepLoad.started && siblingLoad.started);
    deepLoad.resolve();
    await deepLoad.loading;
    await flushMicrotasks();

    expect(visiblePaths()).toEqual(collapsedRows);
    expect(mountedPaths()).toEqual(collapsedRows);
    expect(treeView.rebuildVisibleRows).not.toHaveBeenCalled();

    siblingLoad.resolve();
    await parent.entriesLoadedPromise;
    await reopening;
    await conditionPromise(() => visiblePaths().includes(fullPath("A/S/sibling.txt")));
    await flushMicrotasks();

    expect(snapshots).toEqual([expandedRows]);
    expect(treeView.rebuildVisibleRows).toHaveBeenCalledTimes(1);
  });

  it("discards a pending restoration when A is collapsed and reopened again", async () => {
    const { parent, expandedRows, collapsedRows } = await prepareExpandedTree(["A/B"]);
    const oldLoad = gate();
    const newLoad = gate();
    holdDirectoryLoads(new Map([[fullPath("A/B"), [oldLoad, newLoad]]]));
    const snapshots = observePresentation();

    track(parent.expand());
    await conditionPromise(() => oldLoad.started);
    const oldChild = treeView.treeEntryForPath(fullPath("A/B"));
    parent.collapse();
    const reopening = track(parent.expand());
    await conditionPromise(() => newLoad.started);
    const newChild = treeView.treeEntryForPath(fullPath("A/B"));
    const rebuildCount = treeView.rebuildVisibleRows.calls.count();
    const snapshotCount = snapshots.length;

    oldLoad.resolve();
    await oldLoad.loading;
    await flushMicrotasks();

    expect(oldChild).not.toBe(newChild);
    expect(oldChild.directory.destroyed).toBe(true);
    expect(treeView.treeEntries.has(oldChild)).toBe(false);
    expect(treeView.treeEntryForPath(fullPath("A/B"))).toBe(newChild);
    expect(visiblePaths()).toEqual(collapsedRows);
    expect(mountedPaths()).toEqual(collapsedRows);
    expect(treeView.rebuildVisibleRows.calls.count()).toBe(rebuildCount);

    newLoad.resolve();
    await parent.entriesLoadedPromise;
    await reopening;
    await conditionPromise(() => visiblePaths().includes(fullPath("A/B/two.txt")));
    await flushMicrotasks();

    expect(snapshots.slice(snapshotCount)).toEqual([expandedRows]);
    expect(treeView.rebuildVisibleRows.calls.count()).toBe(rebuildCount + 1);
  });

  it("lets another project expand without publishing A's pending descendants", async () => {
    const { parent, expandedRows } = await prepareExpandedTree(["A/B"]);
    const childLoad = gate();
    holdDirectoryLoads(new Map([[fullPath("A/B"), [childLoad]]]));
    const snapshots = observePresentation();

    const reopening = track(parent.expand());
    await conditionPromise(() => childLoad.started);
    await expand(otherProjectPath);

    const otherFile = path.join(otherProjectPath, "other.txt");
    expect(visiblePaths()).toContain(otherFile);
    expect(mountedPaths()).toContain(otherFile);
    expect(visiblePaths()).not.toContain(fullPath("A/B"));
    expect(mountedPaths()).not.toContain(fullPath("A/B"));
    expect(snapshots.some((rows) => rows.includes(otherFile))).toBe(true);
    expect(snapshots.every((rows) => !rows.includes(fullPath("A/B")))).toBe(true);

    childLoad.resolve();
    await parent.entriesLoadedPromise;
    await reopening;
    await conditionPromise(() => visiblePaths().includes(fullPath("A/B/two.txt")));

    expect(visiblePaths()).toEqual([...expandedRows, otherFile]);
    expect(mountedPaths()).toEqual([...expandedRows, otherFile]);
  });

  it("keeps Right-arrow selection on A until its remembered descendants are presented", async () => {
    const { parent } = await prepareExpandedTree(["A/B"]);
    const childLoad = gate();
    holdDirectoryLoads(new Map([[fullPath("A/B"), [childLoad]]]));
    treeView.selectEntry(parent);

    const reopening = track(parent.expand());
    await conditionPromise(() => childLoad.started);
    expect(parent.children.length).toBeGreaterThan(0);
    expect(visiblePaths()).not.toContain(fullPath("A/B"));

    treeView.expandDirectory(false);

    expect(treeView.selectedEntry()).toBe(parent);

    childLoad.resolve();
    await parent.entriesLoadedPromise;
    await reopening;
    treeView.expandDirectory(false);

    expect(treeView.selectedEntry()).toBe(treeView.treeEntryForPath(fullPath("A/B")));
    expect(mountedPaths()).toContain(treeView.selectedEntry().getPath());
  });

  it("settles restoration when a parent refresh removes a remembered-open child", async () => {
    const { parent, expandedRows } = await prepareExpandedTree(["A/B"]);
    const childLoad = gate();
    holdDirectoryLoads(new Map([[fullPath("A/B"), [childLoad]]]));
    const snapshots = observePresentation();

    const reopening = track(parent.expand());
    await conditionPromise(() => childLoad.started);
    const removedChild = treeView.treeEntryForPath(fullPath("A/B"));
    fs.rmSync(fullPath("A/B"), { recursive: true, force: true });
    await track(parent.directory.reloadAsync({ rescan: true }));
    await parent.entriesLoadedPromise;
    await reopening;

    const remainingRows = expandedRows.filter(
      (entryPath) =>
        entryPath !== fullPath("A/B") && !entryPath.startsWith(fullPath("A/B") + path.sep),
    );
    expect(removedChild.directory.destroyed).toBe(true);
    expect(treeView.treeEntries.has(removedChild)).toBe(false);
    expect(treeView.treeEntryForPath(fullPath("A/B"))?.getPath()).not.toBe(fullPath("A/B"));
    expect(parent.isExpanded).toBe(true);
    expect(visiblePaths()).toEqual(remainingRows);
    expect(mountedPaths()).toEqual(remainingRows);
    expect(snapshots.every((rows) => !rows.includes(fullPath("A/B")))).toBe(true);
    const snapshotsBeforeStaleLoad = snapshots.length;

    childLoad.resolve();
    await childLoad.loading;
    await flushMicrotasks();

    expect(visiblePaths()).toEqual(remainingRows);
    expect(mountedPaths()).toEqual(remainingRows);
    expect(snapshots.length).toBe(snapshotsBeforeStaleLoad);
  });

  it("presents the whole restored subtree before its watchers are ready", async () => {
    const { parent, expandedRows } = await prepareExpandedTree(["A/B"]);
    const watcherReady = gate();
    const watch = Directory.prototype.watch;
    const watchedPaths = [];
    spyOn(Directory.prototype, "watch").and.callFake(function () {
      if (this.path === fullPath("A") || this.path === fullPath("A/B")) {
        watchedPaths.push(this.path);
        return watcherReady.promise;
      }
      return watch.call(this);
    });
    const snapshots = observePresentation();
    const settled = jasmine.createSpy("expansion settled");

    const reopening = track(parent.expand());
    reopening.then(settled, settled);
    await parent.entriesLoadedPromise;
    await conditionPromise(() => visiblePaths().includes(fullPath("A/B/two.txt")));
    await flushMicrotasks();

    expect(watchedPaths).toContain(fullPath("A"));
    expect(watchedPaths).toContain(fullPath("A/B"));
    expect(mountedPaths()).toEqual(expandedRows);
    expect(snapshots).toEqual([expandedRows]);
    expect(settled).not.toHaveBeenCalled();

    watcherReady.resolve();
    await reopening;
    await flushMicrotasks();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(treeView.rebuildVisibleRows).toHaveBeenCalledTimes(1);
  });

  it("waits for restored rows to be presented before scrolling to a revealed file", async () => {
    await prepareExpandedTree(["A/B", "A/S"]);
    const siblingLoad = gate();
    holdDirectoryLoads(new Map([[fullPath("A/S"), [siblingLoad]]]));
    const scrollSnapshots = [];
    spyOn(treeView, "scrollToEntry").and.callFake((entry) => {
      scrollSnapshots.push({
        path: entry.getPath(),
        visible: treeView.visibleRows.includes(entry),
        mounted: treeView.rowViews.has(entry),
        index: entry.index,
      });
    });
    const target = fullPath("A/B/one.txt");

    const revealing = track(treeView.revealPath(target, { show: false, focus: false }));
    await conditionPromise(
      () => siblingLoad.started && treeView.treeEntryForPath(target)?.getPath() === target,
      "target model loaded while remembered sibling is still pending",
    );
    await flushMicrotasks();

    expect(treeView.treeEntryForPath(target)).toBeDefined();
    expect(treeView.scrollToEntry).not.toHaveBeenCalled();
    expect(treeView.selectedEntry()?.getPath()).not.toBe(target);

    siblingLoad.resolve();
    await revealing;

    const targetEntry = treeView.treeEntryForPath(target);
    expect(treeView.selectedEntry()).toBe(targetEntry);
    expect(scrollSnapshots).toEqual([
      { path: target, visible: true, mounted: true, index: targetEntry.index },
    ]);
    expect(targetEntry.index).toBeGreaterThan(-1);
  });
});
