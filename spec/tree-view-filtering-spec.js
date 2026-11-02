const fs = require("fs");
const os = require("os");
const path = require("path");
const { Disposable } = require("lumine");
const Directory = require("../lib/directory");
const treeFS = require("../lib/fs-compat");
const TreeView = require("../lib/tree-view");

describe("TreeView filtering without rebuilding the tree", () => {
  let originalPaths;
  let originalSettings;
  let temporaryPath;
  let projectPath;
  let pinnedPath;
  let fixture;
  let stylesheet;
  let treeView;
  let gates;
  let operations;
  let repositoryLookup;
  const settings = {
    "core.ignoredNames": ["*.ignored", "hidden-directory"],
    "tree-view.hideIgnoredNames": false,
    "tree-view.hideVcsIgnoredFiles": false,
    "tree-view.squashDirectoryNames": false,
    "tree-view.sortMethod": "default",
    "tree-view.sortByBase": true,
    "tree-view.sortFoldersBeforeFiles": true,
    "tree-view.autoReveal": false,
    "tree-view.stickyHeaders": "none",
  };

  beforeEach(async () => {
    originalPaths = lumine.project.getPaths();
    originalSettings = new Map();
    for (const [key, value] of Object.entries(settings)) {
      originalSettings.set(key, lumine.config.get(key));
      lumine.config.set(key, value);
    }
    gates = [];
    operations = [];
    repositoryLookup = null;
    temporaryPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-filter-")));
    projectPath = path.join(temporaryPath, "project");
    pinnedPath = path.join(temporaryPath, "pinned");
    for (const relativePath of ["A/hidden-directory/nested", "A/visible-directory"]) {
      fs.mkdirSync(fullPath(relativePath), { recursive: true });
    }
    fs.mkdirSync(path.join(pinnedPath, "nested"), { recursive: true });
    for (const relativePath of [
      "A/hidden-directory/nested/deep.txt",
      "A/visible-directory/inside.ignored",
      "A/visible-directory/inside.txt",
    ]) {
      fs.writeFileSync(fullPath(relativePath), relativePath);
    }
    for (let index = 0; index < 100; index++) {
      const extension = index % 3 === 0 ? ".ignored" : ".txt";
      const name = `item-${String(index).padStart(3, "0")}${extension}`;
      fs.writeFileSync(fullPath(`A/${name}`), name);
    }
    for (const name of ["inside.ignored", "inside.txt"]) {
      fs.writeFileSync(path.join(pinnedPath, "nested", name), name);
    }
    lumine.project.setPaths([projectPath]);
    stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8"),
      { priority: 1000 },
    );
    fixture = document.createElement("div");
    fixture.className = "item-views";
    fixture.style.cssText =
      "position:fixed;left:40px;top:40px;width:320px;height:220px;z-index:10000";
    treeView = new TreeView({
      directoryExpansionStates: { [projectPath]: { isExpanded: false } },
    });
    treeView.element.style.cssText = "width:100%;height:100%";
    fixture.appendChild(treeView.element);
    jasmine.attachToDOM(fixture);
    await expand(projectPath);
    await expand(fullPath("A"));
    await settle();
  });

  afterEach(async () => {
    for (const pending of gates) pending.resolve();
    await Promise.allSettled(operations);
    await treeView?.destroy();
    repositoryLookup?.and.callThrough();
    fixture?.remove();
    stylesheet?.dispose();
    lumine.project.setPaths(originalPaths);
    for (const [key, value] of originalSettings) {
      if (value === undefined) lumine.config.unset(key);
      else lumine.config.set(key, value);
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(temporaryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function fullPath(relativePath) {
    return path.join(projectPath, ...relativePath.split("/"));
  }

  async function expand(entryPath) {
    const entry = treeView.treeEntryForPath(entryPath);
    const operation = entry.expand();
    operations.push(operation);
    await operation;
    await entry.entriesLoadedPromise;
    return entry;
  }

  async function settle() {
    let frames = 0;
    await waitForFrames(() => ++frames === 3);
  }

  async function recreateTree(state) {
    await treeView.destroy();
    treeView.element.remove();
    treeView = new TreeView(state);
    treeView.element.style.cssText = "width:100%;height:100%";
    fixture.appendChild(treeView.element);
    await expand(projectPath);
    await expand(fullPath("A"));
    await settle();
  }

  function expectSameNativePixel(actual, expected) {
    // Measured row heights can be fractional CSS pixels, while native scroll
    // offsets round to the device-pixel grid. Allow one native pixel only.
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1 / window.devicePixelRatio);
  }

  async function toggleIgnoredNames() {
    lumine.commands.dispatch(treeView.element, "tree-view:toggle-ignored-names");
    await settle();
  }

  function visiblePaths() {
    return treeView.visibleRows.map((entry) => entry.getPath());
  }

  function mountedPaths() {
    return Array.from(treeView.list.querySelectorAll(".tree-view-row"), (row) =>
      row.treeEntry.getPath(),
    );
  }

  function rowFor(entry) {
    return treeView.rowViews.get(entry)?.element;
  }

  function observePresentation() {
    const snapshots = [];
    const renderVisibleRows = treeView.renderVisibleRows;
    spyOn(treeView, "renderVisibleRows").and.callFake(function () {
      renderVisibleRows.call(this);
      snapshots.push(mountedPaths());
    });
    return snapshots;
  }

  it("keeps surviving models, DOM and the visible scroll anchor in both toggle directions", async () => {
    const root = treeView.roots[0];
    const parent = treeView.treeEntryForPath(fullPath("A"));
    // The first watcher reconciliation belongs to initial loading. Let it
    // finish before checking that filter changes schedule no further reads.
    advanceClock(101);
    await Promise.all([root, parent].map((entry) => entry.directory.listingTask?.promise));
    const reload = spyOn(Directory.prototype, "reloadAsync").and.callThrough();
    const toggleWithoutReading = async () => {
      reload.calls.reset();
      lumine.commands.dispatch(treeView.element, "tree-view:toggle-ignored-names");
      await flushMicrotasks();
      // Native watchers may independently reconcile on later frames. The
      // command and its queued work must not start a filesystem listing.
      expect(reload).not.toHaveBeenCalled();
      await settle();
    };
    const anchor = treeView.treeEntryForPath(fullPath("A/item-050.txt"));
    const rootRow = rowFor(root);
    const parentRow = rowFor(parent);
    const anchorRow = rowFor(anchor);
    treeView.setScrollTop(anchor.top + 5);
    await settle();
    const anchorY = anchorRow.getBoundingClientRect().top;
    const originalScrollTop = treeView.scroller.scrollTop;
    const snapshots = observePresentation();

    await toggleWithoutReading();

    expect(lumine.config.get("tree-view.hideIgnoredNames")).toBe(true);
    expect(treeView.roots[0]).toBe(root);
    expect(treeView.treeEntryForPath(parent.getPath())).toBe(parent);
    expect(treeView.treeEntryForPath(anchor.getPath())).toBe(anchor);
    expect(rowFor(root)).toBe(rootRow);
    expect(rowFor(parent)).toBe(parentRow);
    expect(rowFor(anchor)).toBe(anchorRow);
    expectSameNativePixel(anchorRow.getBoundingClientRect().top, anchorY);
    expect(treeView.scroller.scrollTop).toBeGreaterThan(0);
    expect(treeView.scroller.scrollTop).toBeLessThan(originalScrollTop);
    expect(visiblePaths()).not.toContain(fullPath("A/item-048.ignored"));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((rows) => rows.includes(anchor.getPath()))).toBe(true);

    await toggleWithoutReading();

    expect(rowFor(anchor)).toBe(anchorRow);
    expectSameNativePixel(anchorRow.getBoundingClientRect().top, anchorY);
    expectSameNativePixel(treeView.scroller.scrollTop, originalScrollTop);
    expect(visiblePaths()).toContain(fullPath("A/item-048.ignored"));
    expect(mountedPaths()).toEqual(visiblePaths());
    expect(snapshots.every((rows) => rows.includes(anchor.getPath()))).toBe(true);
  });

  it("selects the nearest visible ancestor when the selected entry becomes hidden", async () => {
    await expand(fullPath("A/hidden-directory"));
    await expand(fullPath("A/hidden-directory/nested"));
    const parent = treeView.treeEntryForPath(fullPath("A"));
    const hidden = treeView.treeEntryForPath(fullPath("A/hidden-directory/nested/deep.txt"));
    treeView.selectEntry(hidden);

    await toggleIgnoredNames();

    expect(treeView.getSelectedEntries()).toEqual([parent]);
    expect(treeView.selectedEntry()).toBe(parent);
    expect(rowFor(parent).classList.contains("selected")).toBe(true);
    expect(treeView.getSelectionSnapshot().paths).toEqual([parent.getPath()]);
  });

  it("keeps the nearest surviving row at its previous screen position when the anchor is hidden", async () => {
    const hidden = treeView.treeEntryForPath(fullPath("A/item-048.ignored"));
    const neighbor = treeView.treeEntryForPath(fullPath("A/item-049.txt"));
    const neighborRow = rowFor(neighbor);
    treeView.setScrollTop(hidden.top + 5);
    await settle();
    const neighborY = neighborRow.getBoundingClientRect().top;

    await toggleIgnoredNames();

    expect(visiblePaths()).not.toContain(hidden.getPath());
    expect(rowFor(neighbor)).toBe(neighborRow);
    expectSameNativePixel(neighborRow.getBoundingClientRect().top, neighborY);
    expect(treeView.scroller.scrollTop).toBeGreaterThan(0);
  });

  it("retains surviving multiple selections and their focused entry", async () => {
    const hidden = treeView.treeEntryForPath(fullPath("A/item-048.ignored"));
    const first = treeView.treeEntryForPath(fullPath("A/item-049.txt"));
    const focused = treeView.treeEntryForPath(fullPath("A/item-050.txt"));
    treeView.selectEntry(hidden);
    treeView.selectMultipleEntries(first);
    treeView.selectMultipleEntries(focused);

    await toggleIgnoredNames();

    expect(treeView.getSelectedEntries()).toContain(first);
    expect(treeView.getSelectedEntries()).toContain(focused);
    expect(treeView.getSelectedEntries()).not.toContain(hidden);
    expect(treeView.selectedEntry()).toBe(focused);
    expect(rowFor(first).classList.contains("selected")).toBe(true);
    expect(rowFor(focused).classList.contains("selected")).toBe(true);
  });

  it("restores a hidden expanded subtree with its existing directory models", async () => {
    const hidden = await expand(fullPath("A/hidden-directory"));
    const nested = await expand(fullPath("A/hidden-directory/nested"));
    const deep = treeView.treeEntryForPath(fullPath("A/hidden-directory/nested/deep.txt"));

    await toggleIgnoredNames();

    expect(visiblePaths()).not.toContain(hidden.getPath());
    expect(visiblePaths()).not.toContain(nested.getPath());
    expect(visiblePaths()).not.toContain(deep.getPath());

    await toggleIgnoredNames();

    expect(treeView.treeEntryForPath(hidden.getPath())).toBe(hidden);
    expect(treeView.treeEntryForPath(nested.getPath())).toBe(nested);
    expect(treeView.treeEntryForPath(deep.getPath())).toBe(deep);
    expect(hidden.isExpanded).toBe(true);
    expect(nested.isExpanded).toBe(true);
    expect(visiblePaths()).toContain(deep.getPath());
    expect(mountedPaths()).toEqual(visiblePaths());
  });

  it("updates ignored styling and visibility when the core patterns change", async () => {
    const entry = treeView.treeEntryForPath(fullPath("A/item-050.txt"));
    const row = rowFor(entry);
    const survivor = treeView.treeEntryForPath(fullPath("A/item-049.txt"));
    const survivorRow = rowFor(survivor);
    expect(row.classList.contains("ignored-name")).toBe(false);

    lumine.config.set("core.ignoredNames", ["item-050.txt"]);
    await settle();

    expect(treeView.treeEntryForPath(entry.getPath())).toBe(entry);
    expect(rowFor(entry)).toBe(row);
    expect(row.classList.contains("ignored-name")).toBe(true);
    await toggleIgnoredNames();
    expect(visiblePaths()).not.toContain(entry.getPath());

    lumine.config.set("core.ignoredNames", ["*.ignored"]);
    await settle();

    expect(treeView.treeEntryForPath(entry.getPath())).toBe(entry);
    expect(visiblePaths()).toContain(entry.getPath());
    expect(rowFor(entry).classList.contains("ignored-name")).toBe(false);
    expect(rowFor(survivor)).toBe(survivorRow);
    expect(visiblePaths()).not.toContain(fullPath("A/item-048.ignored"));
  });

  it("keeps keyboard navigation and revealing a path on visible rows", async () => {
    await expand(fullPath("A/hidden-directory"));
    await expand(fullPath("A/hidden-directory/nested"));
    const parent = treeView.treeEntryForPath(fullPath("A"));
    const firstVisibleChild = treeView.treeEntryForPath(fullPath("A/visible-directory"));
    const hiddenPath = fullPath("A/hidden-directory/nested/deep.txt");
    await toggleIgnoredNames();

    treeView.selectEntry(parent);
    lumine.commands.dispatch(treeView.element, "core:move-down");
    expect(treeView.selectedEntry()).toBe(firstVisibleChild);

    treeView.selectEntry(parent);
    lumine.commands.dispatch(treeView.element, "tree-view:expand-item");
    expect(treeView.selectedEntry()).toBe(firstVisibleChild);

    await treeView.revealPath(hiddenPath, { show: false, focus: false });

    expect(treeView.selectedEntry()).toBe(parent);
    expect(visiblePaths()).toContain(treeView.selectedEntry().getPath());
    expect(visiblePaths()).not.toContain(hiddenPath);
  });

  it("applies the same filter to expanded directories in special root sections", async () => {
    const pinnedIgnoredFile = fullPath("A/item-048.ignored");
    const authoredPaths = [pinnedPath, pinnedIgnoredFile];
    const section = treeView.addSpecialRoot({
      name: "Pinned",
      className: "filter-pins",
      entryClassName: "filter-pin-entry",
      getEntries: () => authoredPaths,
    });
    const pinned = section.entries[0];
    await pinned.expand();
    const nested = pinned.children.find((entry) => entry.name === "nested");
    await nested.expand();
    const survivor = nested.children.find((entry) => entry.name === "inside.txt");
    const hidden = nested.children.find((entry) => entry.name === "inside.ignored");
    const row = rowFor(survivor);

    await toggleIgnoredNames();

    expect(visiblePaths()).toContain(pinned.getPath());
    expect(visiblePaths()).toContain(survivor.getPath());
    expect(visiblePaths()).not.toContain(hidden.getPath());
    expect(rowFor(survivor)).toBe(row);
    expect(
      treeView.visibleRows
        .filter((entry) => entry.parent === section.root)
        .map((entry) => entry.getPath()),
    ).toEqual(authoredPaths);

    await toggleIgnoredNames();

    expect(section.entries[0]).toBe(pinned);
    expect(pinned.children).toContain(nested);
    expect(nested.isExpanded).toBe(true);
    expect(visiblePaths()).toContain(hidden.getPath());
    expect(rowFor(survivor)).toBe(row);
    expect(
      treeView.visibleRows
        .filter((entry) => entry.parent === section.root)
        .map((entry) => entry.getPath()),
    ).toEqual(authoredPaths);
  });

  it("refreshes VCS visibility from configuration and cached repository snapshots", async () => {
    const firstPath = fullPath("A/item-048.ignored");
    const secondPath = fullPath("A/item-049.txt");
    const ignoredPaths = new Set([firstPath]);
    const callbacks = new Set();
    const repository = {
      getWorkingDirectory: () => projectPath,
      isSubmodule: () => false,
      getDirectoryStatusSummary: () => null,
      getPathStatusSummary: () => null,
      isPathIgnoredCached: (candidate) => ignoredPaths.has(candidate),
      getStatusSnapshot: () => ({
        initialized: true,
        includesIgnored: true,
        files: Array.from(ignoredPaths, (path) => ({ path, ignored: true })),
      }),
      onDidChangeStatusSnapshot(callback) {
        callbacks.add(callback);
        return new Disposable(() => callbacks.delete(callback));
      },
    };
    const getForPath = lumine.repositories.getForPath.bind(lumine.repositories);
    repositoryLookup = spyOn(lumine.repositories, "getForPath").and.callFake((candidate) =>
      candidate === projectPath || candidate?.startsWith(projectPath + path.sep)
        ? repository
        : getForPath(candidate),
    );
    await recreateTree({});
    const root = treeView.roots[0];
    const first = treeView.treeEntryForPath(firstPath);
    const second = treeView.treeEntryForPath(secondPath);
    const secondRow = rowFor(second);

    lumine.config.set("tree-view.hideVcsIgnoredFiles", true);
    await settle();

    expect(visiblePaths()).not.toContain(firstPath);
    expect(visiblePaths()).toContain(secondPath);
    expect(rowFor(second)).toBe(secondRow);
    ignoredPaths.clear();
    ignoredPaths.add(secondPath);
    for (const callback of Array.from(callbacks)) callback();
    await conditionPromise(
      () => visiblePaths().includes(firstPath) && !visiblePaths().includes(secondPath),
    );
    await settle();

    expect(treeView.roots[0]).toBe(root);
    expect(treeView.treeEntryForPath(firstPath)).toBe(first);

    lumine.config.set("tree-view.hideVcsIgnoredFiles", false);
    await settle();

    expect(treeView.treeEntryForPath(secondPath)).toBe(second);
    expect(visiblePaths()).toContain(secondPath);
  });

  it("keeps the current sort projection and anchor when an older directory read completes", async () => {
    const parent = treeView.treeEntryForPath(fullPath("A"));
    const anchor = treeView.treeEntryForPath(fullPath("A/item-050.txt"));
    const anchorRow = rowFor(anchor);
    const lateDirectory = treeView.treeEntryForPath(fullPath("A/visible-directory"));
    treeView.setScrollTop(anchor.top + 5);
    await settle();
    const anchorY = anchorRow.getBoundingClientRect().top;
    let resolve;
    const promise = new Promise((callback) => {
      resolve = callback;
    });
    const pending = { resolve, started: false };
    gates.push(pending);
    const readdir = treeFS.promises.readdir;
    spyOn(treeFS.promises, "readdir").and.callFake(function (directoryPath, ...args) {
      if (directoryPath === parent.getPath() && !pending.started) {
        pending.started = true;
        return promise.then(() => readdir.call(this, directoryPath, ...args));
      }
      return readdir.call(this, directoryPath, ...args);
    });
    const reading = parent.directory.reloadAsync({ rescan: true });
    operations.push(reading);
    await conditionPromise(() => pending.started);
    fs.writeFileSync(fullPath("A/aaa.txt"), "new entry");

    lumine.config.set("tree-view.sortFoldersBeforeFiles", false);
    await settle();

    expect(anchor.index).toBeLessThan(lateDirectory.index);
    expect(rowFor(anchor)).toBe(anchorRow);
    expectSameNativePixel(anchorRow.getBoundingClientRect().top, anchorY);
    pending.resolve();
    await reading;
    await settle();

    expect(treeView.treeEntryForPath(fullPath("A"))).toBe(parent);
    expect(treeView.visibleRows.find((entry) => entry.parent === parent).getPath()).toBe(
      fullPath("A/aaa.txt"),
    );
    expect(anchor.index).toBeLessThan(lateDirectory.index);
    expect(rowFor(anchor)).toBe(anchorRow);
    expectSameNativePixel(anchorRow.getBoundingClientRect().top, anchorY);
    expect(mountedPaths()).toEqual(visiblePaths());
  });

  it("restores saved expansion below an initially hidden directory when it becomes visible", async () => {
    await expand(fullPath("A/hidden-directory"));
    await expand(fullPath("A/hidden-directory/nested"));
    await toggleIgnoredNames();
    const state = JSON.parse(JSON.stringify(treeView.serialize()));
    await recreateTree(state);
    const deepPath = fullPath("A/hidden-directory/nested/deep.txt");

    expect(visiblePaths()).not.toContain(fullPath("A/hidden-directory"));
    expect(visiblePaths()).not.toContain(deepPath);
    await toggleIgnoredNames();
    await conditionPromise(() => visiblePaths().includes(deepPath));

    expect(treeView.treeEntryForPath(fullPath("A/hidden-directory")).isExpanded).toBe(true);
    expect(treeView.treeEntryForPath(fullPath("A/hidden-directory/nested")).isExpanded).toBe(true);
    expect(mountedPaths()).toEqual(visiblePaths());
  });

  it("restores a remembered child shown between parent restoration and its final publication", async () => {
    await expand(fullPath("A/hidden-directory"));
    await expand(fullPath("A/hidden-directory/nested"));
    const parent = treeView.treeEntryForPath(fullPath("A"));
    parent.collapse();
    await toggleIgnoredNames();
    let resolve;
    const promise = new Promise((callback) => {
      resolve = callback;
    });
    const pending = { resolve, restored: false };
    gates.push(pending);
    const restoreTreeEntry = treeView.restoreTreeEntry;
    spyOn(treeView, "restoreTreeEntry").and.callFake(async function (entry, isCurrent) {
      await restoreTreeEntry.call(this, entry, isCurrent);
      if (entry === parent) {
        pending.restored = true;
        await promise;
      }
    });
    const reopening = parent.expand();
    operations.push(reopening);
    await conditionPromise(() => pending.restored);
    expect(parent.restoringExpansion).not.toBeNull();
    const hidden = parent.children.find((entry) => entry.name === "hidden-directory");
    expect(hidden.isExpanded).toBe(false);

    lumine.config.set("tree-view.hideIgnoredNames", false);
    expect(hidden.isExpanded).toBe(false);
    pending.resolve();
    await reopening;
    const deepPath = fullPath("A/hidden-directory/nested/deep.txt");
    await conditionPromise(() => visiblePaths().includes(deepPath));

    expect(hidden.isExpanded).toBe(true);
    expect(treeView.treeEntryForPath(fullPath("A/hidden-directory/nested")).isExpanded).toBe(true);
    expect(mountedPaths()).toEqual(visiblePaths());
  });

  it("filters a squashed directory by the original path represented by its row", async () => {
    lumine.config.set("tree-view.squashDirectoryNames", true);
    await expand(projectPath);
    const parent = await expand(fullPath("A"));
    const hidden = parent.children.find((entry) => entry.name === "hidden-directory");
    const survivor = parent.children.find((entry) => entry.name === "visible-directory");
    const survivorRow = rowFor(survivor);
    await hidden.expand();

    expect(hidden.getPath()).toBe(fullPath("A/hidden-directory/nested"));
    await toggleIgnoredNames();

    expect(visiblePaths()).not.toContain(hidden.getPath());
    expect(visiblePaths()).not.toContain(fullPath("A/hidden-directory/nested/deep.txt"));
    expect(rowFor(survivor)).toBe(survivorRow);
    await toggleIgnoredNames();

    expect(parent.children).toContain(hidden);
    expect(hidden.isExpanded).toBe(true);
    expect(visiblePaths()).toContain(fullPath("A/hidden-directory/nested/deep.txt"));
    expect(rowFor(survivor)).toBe(survivorRow);
  });

  it("keeps a nearby viewport position when a long expanded subtree hides the scroll anchor", async () => {
    for (let index = 0; index < 30; index++) {
      fs.writeFileSync(
        fullPath(`A/hidden-directory/nested/deep-${String(index).padStart(2, "0")}.txt`),
        "deep",
      );
      fs.writeFileSync(fullPath(`A/aaa-prefix-${String(index).padStart(2, "0")}.txt`), "prefix");
    }
    // Files precede the hidden directory so a zero scroll offset would show
    // unrelated prefix rows after the expanded subtree disappears.
    lumine.config.set("tree-view.sortFoldersBeforeFiles", false);
    const parent = treeView.treeEntryForPath(fullPath("A"));
    await parent.directory.reloadAsync();
    await expand(fullPath("A/hidden-directory"));
    const hidden = await expand(fullPath("A/hidden-directory/nested"));
    const deep = treeView.treeEntryForPath(fullPath("A/hidden-directory/nested/deep-15.txt"));
    const following = treeView.visibleRows
      .slice(hidden.subtreeEndIndex)
      .find((entry) => entry.name === "item-001.txt");
    treeView.setScrollTop(deep.top + 5);
    await settle();
    const oldOffset =
      rowFor(deep).getBoundingClientRect().top - treeView.scroller.getBoundingClientRect().top;
    expect(following.top - treeView.scroller.scrollTop).toBeGreaterThan(
      treeView.scroller.clientHeight,
    );

    await toggleIgnoredNames();

    expect(treeView.scroller.scrollTop).toBeGreaterThan(0);
    expect(visiblePaths()).toContain(following.getPath());
    const newOffset =
      rowFor(following).getBoundingClientRect().top - treeView.scroller.getBoundingClientRect().top;
    expectSameNativePixel(newOffset, oldOffset);
  });

  it("uses the latest filter when an asynchronous expansion finishes after rapid toggles", async () => {
    const parent = treeView.treeEntryForPath(fullPath("A/visible-directory"));
    let resolve;
    const promise = new Promise((callback) => {
      resolve = callback;
    });
    const pending = { resolve, started: false };
    gates.push(pending);
    const reloadAsync = Directory.prototype.reloadAsync;
    spyOn(Directory.prototype, "reloadAsync").and.callFake(function (options) {
      if (this === parent.directory && !pending.started) {
        pending.started = true;
        return promise.then(() => reloadAsync.call(this, options));
      }
      return reloadAsync.call(this, options);
    });
    const expanding = parent.expand();
    operations.push(expanding);
    await conditionPromise(() => pending.started);
    const root = treeView.roots[0];

    await toggleIgnoredNames();
    await toggleIgnoredNames();
    await toggleIgnoredNames();
    expect(treeView.roots[0]).toBe(root);
    expect(treeView.treeEntryForPath(parent.getPath())).toBe(parent);

    pending.resolve();
    await expanding;
    await settle();

    expect(parent.isExpanded).toBe(true);
    expect(visiblePaths()).toContain(fullPath("A/visible-directory/inside.txt"));
    expect(visiblePaths()).not.toContain(fullPath("A/visible-directory/inside.ignored"));
    expect(mountedPaths()).toEqual(visiblePaths());

    await toggleIgnoredNames();

    expect(visiblePaths()).toContain(fullPath("A/visible-directory/inside.ignored"));
    expect(treeView.treeEntryForPath(parent.getPath())).toBe(parent);
  });
});
