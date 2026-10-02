const TreeView = require("../lib/tree-view");

describe("TreeView asynchronous expansion generations", () => {
  let gates;
  let operations;

  beforeEach(() => {
    gates = [];
    operations = [];
  });

  afterEach(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(operations);
  });

  function gate() {
    let resolve;
    const promise = new Promise((callback) => {
      resolve = callback;
    });
    const result = { promise, resolve };
    gates.push(result);
    return result;
  }

  function track(promise) {
    operations.push(promise);
    return promise;
  }

  function fixture() {
    const directory = {
      destroyed: false,
      expansionGeneration: 0,
      expand: jasmine.createSpy("expand directory"),
      collapse: jasmine.createSpy("collapse directory").and.callFake(() => {
        directory.expansionGeneration++;
      }),
    };
    const root = {
      kind: "directory",
      directory,
      isExpanded: false,
      children: [],
      syncViews: jasmine.createSpy("sync root views"),
    };
    // Exercise the real entry lifecycle with a controlled model and no DOM,
    // filesystem, watchers, or package activation involved in its timing.
    const treeView = {
      treeEntries: new Set([root]),
      selectedEntries: new Set([root]),
      rebuildVisibleRows: jasmine.createSpy("rebuild visible rows"),
      unregisterTreeEntry: jasmine.createSpy("unregister entry").and.callFake((entry) => {
        treeView.treeEntries.delete(entry);
      }),
      expandTreeEntry: TreeView.prototype.expandTreeEntry,
      collapseTreeEntry: TreeView.prototype.collapseTreeEntry,
    };
    return { treeView, root, directory };
  }

  it("makes concurrent expansion callers wait for the same pending load and watcher", async () => {
    const { treeView, root, directory } = fixture();
    const childrenLoaded = gate();
    const watcherReady = gate();
    const child = { kind: "file" };
    directory.expand.and.callFake(() => {
      directory.entriesLoadedPromise = childrenLoaded.promise.then(() => {
        root.children.push(child);
      });
      return Promise.all([directory.entriesLoadedPromise, watcherReady.promise]);
    });
    const firstSettled = jasmine.createSpy("first expansion settled");
    const secondSettled = jasmine.createSpy("second expansion settled");
    const first = track(treeView.expandTreeEntry(root));
    const pendingExpansion = root.expansionPromise;
    const second = track(treeView.expandTreeEntry(root));
    first.then(firstSettled);
    second.then(secondSettled);

    expect(root.isExpanded).toBe(true);
    expect(root.children).toEqual([]);
    expect(directory.expand).toHaveBeenCalledTimes(1);
    expect(root.expansionPromise).toBe(pendingExpansion);
    await flushMicrotasks();
    expect(firstSettled).not.toHaveBeenCalled();
    expect(secondSettled).not.toHaveBeenCalled();

    childrenLoaded.resolve();
    await directory.entriesLoadedPromise;
    await flushMicrotasks();
    expect(root.children).toEqual([child]);
    expect(firstSettled).not.toHaveBeenCalled();
    expect(secondSettled).not.toHaveBeenCalled();
    expect(root.expansionPromise).toBe(pendingExpansion);

    watcherReady.resolve();
    await Promise.all([first, second]);
    expect(firstSettled).toHaveBeenCalledTimes(1);
    expect(secondSettled).toHaveBeenCalledTimes(1);
    expect(directory.expand).toHaveBeenCalledTimes(1);
    expect(root.expansionPromise).toBeNull();
  });

  it("does not let an old recursive expansion act on children from a re-expansion", async () => {
    const { treeView, root, directory } = fixture();
    const oldReady = gate();
    const newReady = gate();
    directory.expand.and.returnValues(oldReady.promise, newReady.promise);
    const oldExpansion = track(treeView.expandTreeEntry(root, true));

    treeView.collapseTreeEntry(root);
    expect(root.isExpanded).toBe(false);
    expect(directory.expansionGeneration).toBe(1);

    const newExpansion = track(treeView.expandTreeEntry(root, false));
    const freshChild = {
      kind: "directory",
      expand: jasmine.createSpy("expand fresh child").and.returnValue(Promise.resolve()),
    };
    root.children.push(freshChild);
    treeView.treeEntries.add(freshChild);
    const rebuildsBeforeOldCompletion = treeView.rebuildVisibleRows.calls.count();

    oldReady.resolve();
    await oldExpansion;

    expect(root.isExpanded).toBe(true);
    expect(root.expansionPromise).toBe(newReady.promise);
    expect(freshChild.expand).not.toHaveBeenCalled();
    expect(treeView.rebuildVisibleRows.calls.count()).toBe(rebuildsBeforeOldCompletion);

    newReady.resolve();
    await newExpansion;
    expect(freshChild.expand).not.toHaveBeenCalled();
    expect(root.expansionPromise).toBeNull();
  });

  it("stops walking the old child snapshot when collapse interrupts a recursive child", async () => {
    const { treeView, root, directory } = fixture();
    const firstChildReady = gate();
    const newReady = gate();
    const firstChild = {
      kind: "directory",
      expand: jasmine.createSpy("expand first child").and.returnValue(firstChildReady.promise),
    };
    const laterChild = {
      kind: "directory",
      expand: jasmine.createSpy("expand later child").and.returnValue(Promise.resolve()),
    };
    root.isExpanded = true;
    root.children = [firstChild, laterChild];
    treeView.treeEntries.add(firstChild);
    treeView.treeEntries.add(laterChild);
    const oldExpansion = track(treeView.expandTreeEntry(root, true));
    expect(firstChild.expand).toHaveBeenCalledOnceWith(true);

    treeView.collapseTreeEntry(root);
    directory.expand.and.returnValue(newReady.promise);
    const newExpansion = track(treeView.expandTreeEntry(root, false));
    const rebuildsBeforeOldCompletion = treeView.rebuildVisibleRows.calls.count();

    firstChildReady.resolve();
    await oldExpansion;

    expect(laterChild.expand).not.toHaveBeenCalled();
    expect(root.expansionPromise).toBe(newReady.promise);
    expect(treeView.rebuildVisibleRows.calls.count()).toBe(rebuildsBeforeOldCompletion);

    newReady.resolve();
    await newExpansion;
    expect(laterChild.expand).not.toHaveBeenCalled();
  });
});
