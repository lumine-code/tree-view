const path = require("path");
const { webUtils } = require("electron");
const TreeView = require("../lib/tree-view");
const TreeEntry = require("../lib/tree-entry");
const TreeViewPackage = require("../lib/tree-view-package");

describe("TreeViewPackage teardown", () => {
  // Nothing fires onDidActivateInitialPackages in a spec run, and deactivate
  // disposes the subscription before awaiting the promise it would resolve —
  // so a package deactivated in that window used to hang forever, which is
  // what stopped any suite from activating the real tree-view.
  it("settles when deactivated before the initial packages activate", async () => {
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    const treeViewPackage = new TreeViewPackage();
    treeViewPackage.activate();

    await Promise.race([
      treeViewPackage.deactivate(),
      new Promise((_resolve, reject) =>
        requestAnimationFrame(() => reject(new Error("deactivate never settled"))),
      ),
    ]);

    expect(treeViewPackage.treeView).toBeNull();
  });

  // The command was in the View menu and in Packages > Tree View but was never
  // registered, and the setting behind it was only read when the tree opened.
  it("moves the tree to the other side when tree-view:toggle-side is dispatched", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const treeViewPackage = new TreeViewPackage();
    treeViewPackage.activate();
    const treeView = treeViewPackage.getTreeViewInstance();
    spyOn(treeView, "moveToPreferredLocation").and.returnValue(Promise.resolve());

    lumine.config.set("tree-view.showOnRightSide", false);
    lumine.commands.dispatch(lumine.workspace.getElement(), "tree-view:toggle-side");

    expect(lumine.config.get("tree-view.showOnRightSide")).toBe(true);
    expect(treeView.getPreferredLocation()).toBe("right");
    expect(treeView.moveToPreferredLocation).toHaveBeenCalled();

    await treeViewPackage.deactivate();
  });
});

describe("TreeView.entryForPath", () => {
  function makeEntry(entryPath, { realPath = entryPath, containedPaths = [] } = {}) {
    const entry = document.createElement("li");
    entry.classList.add("entry");
    entry.getPath = () => entryPath;
    entry.isPathEqual = (pathToCompare) =>
      pathToCompare === entryPath || pathToCompare === realPath;
    if (containedPaths.length > 0) {
      entry.directory = { contains: (p) => containedPaths.includes(p) };
    }
    return entry;
  }

  function entryForPath(entries, entryPath) {
    const list = document.createElement("ol");
    for (const entry of entries) list.appendChild(entry);
    return TreeView.prototype.entryForPath.call({ list }, entryPath);
  }

  it("prefers an exact path match over an earlier symlink whose realpath matches", () => {
    const symlink = makeEntry("/root/AGENTS.md", { realPath: "/root/CLAUDE.md" });
    const target = makeEntry("/root/CLAUDE.md");

    expect(entryForPath([symlink, target], "/root/CLAUDE.md")).toBe(target);
    expect(entryForPath([symlink, target], "/root/AGENTS.md")).toBe(symlink);
  });

  it("resolves a realpath alias when no exact entry exists", () => {
    const symlink = makeEntry("/root/AGENTS.md", { realPath: "/elsewhere/CLAUDE.md" });
    const other = makeEntry("/root/README.md");

    expect(entryForPath([symlink, other], "/elsewhere/CLAUDE.md")).toBe(symlink);
  });

  it("falls back to the deepest directory containing the path", () => {
    const shallow = makeEntry("/root", { containedPaths: ["/root/sub/missing.md"] });
    const deep = makeEntry("/root/sub", { containedPaths: ["/root/sub/missing.md"] });

    expect(entryForPath([shallow, deep], "/root/sub/missing.md")).toBe(deep);
    expect(entryForPath([shallow], "/nowhere/missing.md")).toBeNull();
  });

  it("returns the mounted row for a logical entry", () => {
    const logicalEntry = { getPath: () => "/root/file.js" };
    const element = document.createElement("li");
    const treeView = {
      treeEntries: new Set([logicalEntry]),
      treeEntryForPath: jasmine.createSpy("treeEntryForPath").and.returnValue(logicalEntry),
      elementForTreeEntry: jasmine.createSpy("elementForTreeEntry").and.returnValue(element),
    };

    expect(TreeView.prototype.entryForPath.call(treeView, "/root/file.js")).toBe(element);
    expect(treeView.elementForTreeEntry).toHaveBeenCalledWith(logicalEntry);
  });
});

describe("TreeView root updates", () => {
  it("ignores updates after the project has been cleared during teardown", () => {
    const project = lumine.project;
    const treeView = { selectedPaths: jasmine.createSpy("selectedPaths") };

    try {
      lumine.project = null;
      expect(() => TreeView.prototype.updateRoots.call(treeView)).not.toThrow();
      expect(treeView.selectedPaths).not.toHaveBeenCalled();
    } finally {
      lumine.project = project;
    }
  });

  it("restores a nested selection after rebuilding the project roots", async () => {
    const originalProjectPaths = lumine.project.getPaths();
    const projectPath = path.resolve(__dirname, "..");
    const selectedPath = path.join(__dirname, path.basename(__filename));
    lumine.project.setPaths([projectPath]);
    const treeView = new TreeView({});

    try {
      await treeView.revealPath(selectedPath);
      await treeView.updateRoots();

      expect(treeView.selectedEntry()?.getPath()).toBe(selectedPath);
    } finally {
      treeView.destroy();
      lumine.project.setPaths(originalProjectPaths);
    }
  });

  it("restores multiple selections and focus across separate project roots", async () => {
    const originalProjectPaths = lumine.project.getPaths();
    const firstProjectPath = path.resolve(__dirname, "..");
    const secondProjectPath = path.resolve(__dirname, "..", "..", "archive-view");
    const firstSelectedPath = path.join(firstProjectPath, "package.json");
    const secondSelectedPath = path.join(secondProjectPath, "package.json");
    lumine.project.setPaths([firstProjectPath, secondProjectPath]);
    const treeView = new TreeView({});

    try {
      await treeView.revealPath(firstSelectedPath);
      const firstEntry = treeView.selectedEntry();
      await treeView.revealPath(secondSelectedPath);
      treeView.selectMultipleEntries(firstEntry);

      await treeView.updateRoots();

      expect(treeView.selectedPaths().sort()).toEqual(
        [firstSelectedPath, secondSelectedPath].sort(),
      );
      expect(treeView.selectedEntry()?.getPath()).toBe(firstSelectedPath);
    } finally {
      treeView.destroy();
      lumine.project.setPaths(originalProjectPaths);
    }
  });

  it("keeps the nearest visible ancestor when an ignore toggle hides the selection", async () => {
    const originalProjectPaths = lumine.project.getPaths();
    const originalIgnoredNames = lumine.config.get("core.ignoredNames");
    const originalHideIgnoredNames = lumine.config.get("tree-view.hideIgnoredNames");
    const projectPath = path.resolve(__dirname, "..");
    const selectedPath = path.join(__dirname, path.basename(__filename));
    lumine.project.setPaths([projectPath]);
    lumine.config.set("core.ignoredNames", [path.basename(__filename)]);
    lumine.config.set("tree-view.hideIgnoredNames", false);
    const treeView = new TreeView({});

    try {
      await treeView.revealPath(selectedPath);
      spyOn(treeView, "updateRoots").and.callThrough();

      lumine.config.set("tree-view.hideIgnoredNames", true);
      await treeView.updateRoots.calls.mostRecent().returnValue;

      expect(treeView.selectedEntry()?.getPath()).toBe(__dirname);
    } finally {
      treeView.destroy();
      lumine.project.setPaths(originalProjectPaths);
      lumine.config.set("core.ignoredNames", originalIgnoredNames);
      lumine.config.set("tree-view.hideIgnoredNames", originalHideIgnoredNames);
    }
  });
});

describe("TreeView OS file drops", () => {
  it("uses Electron's native path when adding a dropped folder as a project root", () => {
    const droppedFolder = {};
    const nativePath = path.resolve(__dirname, "..");
    spyOn(webUtils, "getPathForFile").and.callFake((file) =>
      file === droppedFolder ? nativePath : "",
    );
    spyOn(lumine.project, "addPath");
    const event = {
      target: { closest: () => null },
      dataTransfer: { files: [droppedFolder] },
    };
    const treeView = {
      treeEntryForElement: () => null,
    };

    TreeView.prototype.onDrop.call(treeView, event);

    expect(lumine.project.addPath).toHaveBeenCalledWith(nativePath);
  });

  it("ignores a dropped file when Electron cannot resolve its path", () => {
    spyOn(webUtils, "getPathForFile").and.returnValue("");
    spyOn(lumine.project, "addPath");
    const event = {
      target: { closest: () => null },
      dataTransfer: { files: [{}] },
    };
    const treeView = {
      treeEntryForElement: () => null,
    };

    expect(() => TreeView.prototype.onDrop.call(treeView, event)).not.toThrow();
    expect(lumine.project.addPath).not.toHaveBeenCalled();
  });
});

describe("TreeView construction", () => {
  let originalProjectPaths;
  let treeView;

  beforeEach(() => {
    originalProjectPaths = lumine.project.getPaths();
    lumine.project.setPaths([path.resolve(__dirname, "..")]);
  });

  afterEach(() => {
    treeView?.destroy();
    lumine.project.setPaths(originalProjectPaths);
  });

  it("mounts project rows inside the scroller and keeps stickies outside it", () => {
    treeView = new TreeView({});

    expect(treeView.roots.length).toBe(1);
    expect(treeView.visibleRows[0]).toBe(treeView.roots[0]);
    expect(treeView.rowViews.has(treeView.roots[0])).toBe(true);
    expect(treeView.scroller.contains(treeView.elementForTreeEntry(treeView.roots[0]))).toBe(true);
    expect(treeView.scroller.contains(treeView.stickyHeaderLayer)).toBe(false);
    expect(treeView.stickyHeaderLayer.parentElement).toBe(treeView.viewport);
    expect(treeView.operationStatus.parentElement).toBe(treeView.element);
    expect(treeView.operationStatus.hidden).toBe(true);
    expect(treeView.fileOperationProcess.childProcess).toBeUndefined();
  });

  it("reports long-running cross-volume moves through the busy service", () => {
    treeView = new TreeView({});
    const provider = {
      add: jasmine.createSpy("add"),
      changeTitle: jasmine.createSpy("changeTitle"),
      dispose: jasmine.createSpy("dispose"),
    };
    treeView.setBusySignal({ create: () => provider });
    const sourcePath = path.join("root", "large.bin");

    treeView.beginOperationStatus({ id: 7, operation: "move", sourcePath });
    expect(provider.add).toHaveBeenCalledWith("tree-view: Moving large.bin");

    treeView.updateOperationStatus({ id: 7, phase: "copying-to-move" });
    expect(provider.changeTitle).toHaveBeenCalledWith(
      "tree-view: Copying to move large.bin",
      "tree-view: Moving large.bin",
    );

    treeView.finishOperationStatus();
    expect(provider.dispose).toHaveBeenCalled();
  });

  it("renders the current operation and queue with cancel buttons", () => {
    treeView = new TreeView({});
    const sourcePath = path.join("root", "large.bin");
    const nextPath = path.join("root", "next.bin");
    treeView.currentFileOperation = {
      id: 1,
      operation: "copy",
      sourcePath,
      phase: "copying",
      startedAt: Date.now(),
    };
    spyOn(treeView.fileOperationProcess, "getOperations").and.returnValue([
      {
        id: 1,
        operation: "copy",
        sourcePath,
        destinationPath: sourcePath + ".copy",
        state: "running",
      },
      {
        id: 2,
        operation: "copy",
        sourcePath: nextPath,
        destinationPath: nextPath + ".copy",
        state: "queued",
      },
    ]);
    spyOn(treeView.fileOperationProcess, "cancel").and.returnValue(true);

    treeView.showOperationStatus();

    const rows = treeView.operationStatus.querySelectorAll(".tree-view-operation-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Copying large.bin");
    expect(rows[1].textContent).toContain("Next · Copy · next.bin");
    expect(rows[0].querySelector("button")).toHaveClass("tree-view-operation-cancel");
    rows[0].querySelector("button").click();
    rows[1].querySelector("button").click();
    expect(treeView.fileOperationProcess.cancel).toHaveBeenCalledWith(1);
    expect(treeView.fileOperationProcess.cancel).toHaveBeenCalledWith(2);
  });

  it("keeps editor path tracking isolated between queued moves", () => {
    treeView = new TreeView({});
    const firstPath = path.join("root", "first.txt");
    const secondPath = path.join("root", "second.txt");
    const firstBuffer = { setPath: jasmine.createSpy("firstSetPath") };
    const secondBuffer = { setPath: jasmine.createSpy("secondSetPath") };
    const editors = [
      { getPath: () => firstPath, getBuffer: () => firstBuffer },
      { getPath: () => secondPath, getBuffer: () => secondBuffer },
    ];
    spyOn(lumine.workspace, "getTextEditors").and.returnValue(editors);

    treeView.emitter.emit("will-move-entry", { initialPath: firstPath });
    treeView.emitter.emit("will-move-entry", { initialPath: secondPath });
    treeView.emitter.emit("entry-moved", {
      initialPath: firstPath,
      newPath: path.join("root", "moved-first.txt"),
    });

    expect(firstBuffer.setPath).toHaveBeenCalledWith(path.join("root", "moved-first.txt"));
    expect(secondBuffer.setPath).not.toHaveBeenCalled();
    expect(treeView.editorsToMove.has(secondPath)).toBe(true);
  });

  it("keeps registered root sections before mounted project rows", () => {
    treeView = new TreeView({});
    const section = treeView.addSpecialRoot({
      name: "Recent",
      className: "recent",
      entryClassName: "recent-entry",
      iconClass: "icon-history",
      getEntries: () => [__filename],
    });

    expect(treeView.list.firstElementChild).toBe(section.element);
    expect(section.element.nextElementSibling).toBe(
      treeView.elementForTreeEntry(treeView.roots[0]),
    );
  });

  describe("when a root section stops showing its entries", () => {
    function sectionWithSelectedEntry() {
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
      });
      treeView.selectEntry(section.entries[0]);
      expect(treeView.getSelectedEntries()).toEqual([section.entries[0]]);
      return section;
    }

    // A closed section keeps its entries registered, so nothing drops them out
    // of the selection on its own — the selection would stay on a row that is
    // no longer rendered, and every command reading it would act on that row.
    it("hands the selection to the section root when it collapses", () => {
      const section = sectionWithSelectedEntry();

      section.collapse();

      expect(treeView.selectedEntries.has(section.entries[0])).toBe(false);
      expect(treeView.getSelectedEntries()).toEqual([section.root]);
      expect(treeView.lastFocusedEntry).toBe(section.root);
    });

    it("falls back to a project row when the section itself is hidden", () => {
      const section = sectionWithSelectedEntry();

      section.toggleVisible();

      expect(treeView.selectedEntries.has(section.entries[0])).toBe(false);
      expect(treeView.getSelectedEntries()).toEqual([treeView.roots[0]]);
    });

    it("leaves a selection outside the section alone", () => {
      const section = sectionWithSelectedEntry();
      treeView.selectEntry(treeView.roots[0]);

      section.collapse();

      expect(treeView.getSelectedEntries()).toEqual([treeView.roots[0]]);
    });
  });

  describe("a folder pinned in a root section", () => {
    const specDirectory = __dirname;
    let entries, config;

    function register(overrides = {}) {
      treeView = new TreeView({});
      entries = [specDirectory];
      config = {
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => entries,
        ...overrides,
      };
      return treeView.addSpecialRoot(config);
    }

    it("is backed by a real directory, so it expands like a project folder", async () => {
      const section = register();
      const pinned = section.entries[0];

      expect(pinned.kind).toBe("directory");
      expect(pinned.special).toBe(true);
      expect(pinned.section).toBe(section);

      await pinned.expand();

      expect(pinned.isExpanded).toBe(true);
      expect(pinned.children.length).toBeGreaterThan(0);
      const child = pinned.children.find((entry) => entry.name === path.basename(__filename));
      expect(child).toBeDefined();
      // Only the pinned row is virtual — everything under it is an ordinary
      // entry that renames and deletes like any other.
      expect(child.special).toBe(false);
      expect(child.section).toBe(section);
      expect(child.entryClassName).toBe("recent-entry");
    });

    it("leaves the project copy of a pinned path as the one to reveal", async () => {
      const section = register();
      await section.entries[0].expand();

      const found = treeView.treeEntryForPath(specDirectory);

      expect(found).not.toBe(section.entries[0]);
      expect(found.section).toBeNull();
    });

    it("renders the rows it reveals inside the section's own list", async () => {
      const section = register();
      await section.entries[0].expand();
      treeView.rebuildVisibleRows();

      const child = section.entries[0].children[0];
      expect(treeView.elementForTreeEntry(child).parentElement).toBe(section.element);
    });

    it("stays open across a refresh that leaves its path alone", async () => {
      const section = register();
      const pinned = section.entries[0];
      await pinned.expand();

      entries = [specDirectory, __filename];
      section.refresh();

      expect(section.entries[0]).toBe(pinned);
      expect(pinned.isExpanded).toBe(true);
      expect(section.entries[1].kind).toBe("file");
    });

    it("reopens at the same folders after the section is rebuilt", async () => {
      const expansionStates = new Map();
      treeView = new TreeView({});
      entries = [specDirectory];
      config = {
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => entries,
      };
      const section = treeView.addSpecialRoot(config, expansionStates);
      await section.entries[0].expand();
      treeView.removeSpecialRoot(section);

      const rebuilt = treeView.addSpecialRoot(config, expansionStates);

      expect(rebuilt.entries[0].item.expansionState.isExpanded).toBe(true);
    });

    it("drops a path that is gone and re-reads one whose kind changed", () => {
      const section = register();
      const first = section.entries[0];

      entries = [path.join(specDirectory, "does-not-exist")];
      section.refresh();

      expect(section.entries.length).toBe(1);
      expect(section.entries[0]).not.toBe(first);
      expect(section.entries[0].kind).toBe("file");
      expect(section.entries[0].exists).toBe(false);
      expect(treeView.treeEntries.has(first)).toBe(false);
    });
  });

  describe("removing a selection that includes pinned rows", () => {
    it("trashes an ordinary entry through the shell service", async () => {
      treeView = new TreeView({});
      const entry = {
        special: false,
        specialRoot: false,
        parent: null,
        getPath: () => __filename,
      };
      spyOn(treeView, "hasFocus").and.returnValue(true);
      spyOn(treeView, "selectedPaths").and.returnValue([__filename]);
      spyOn(treeView, "getSelectedEntries").and.returnValue([entry]);
      spyOn(treeView, "updateRoots");
      spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(0));
      spyOn(lumine.shell, "trashItem").and.returnValue(Promise.resolve());

      await treeView.removeSelectedEntries();

      expect(lumine.shell.trashItem).toHaveBeenCalledWith(__filename);
    });

    it("hands the pinned paths to the section instead of deleting them", async () => {
      const onRemove = jasmine.createSpy("onRemove");
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
        onRemove,
      });
      spyOn(treeView, "hasFocus").and.returnValue(true);
      spyOn(lumine.window, "confirm");
      treeView.selectEntry(section.entries[0]);

      await treeView.removeSelectedEntries();

      expect(onRemove).toHaveBeenCalledWith([__filename]);
      // The path itself is never handed to the delete machinery.
      expect(lumine.window.confirm).not.toHaveBeenCalled();
    });

    it("does nothing for the section header, which is not a path", async () => {
      const onRemove = jasmine.createSpy("onRemove");
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
        onRemove,
      });
      spyOn(treeView, "hasFocus").and.returnValue(true);
      spyOn(lumine.window, "confirm");
      treeView.selectEntry(section.root);

      await treeView.removeSelectedEntries();

      expect(onRemove).not.toHaveBeenCalled();
      expect(lumine.window.confirm).not.toHaveBeenCalled();
    });
  });

  describe("dropping onto a root section", () => {
    it("hands the dropped paths to the section that owns the header", async () => {
      const onDrop = jasmine.createSpy("onDrop");
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
        onDrop,
      });
      treeView.rebuildVisibleRows();
      const header = treeView.elementForTreeEntry(section.root);
      const event = {
        target: header,
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: {
          items: [{ type: "lumine-tree-view-event", kind: "string" }],
          getData: (key) => (key === "initialPaths" ? JSON.stringify(["/dropped.js"]) : "true"),
        },
      };

      await treeView.onDrop(event);

      expect(onDrop).toHaveBeenCalledWith(["/dropped.js"]);
    });
  });

  describe("revealing a path", () => {
    it("waits for each folder on the way, so it reaches a collapsed subtree", async () => {
      treeView = new TreeView({});
      const target = path.join(__dirname, path.basename(__filename));
      treeView.roots[0].collapse();

      await treeView.revealPath(target);

      expect(treeView.selectedEntry()?.getPath()).toBe(target);
    });

    it("selects a directory it reveals rather than only expanding it", async () => {
      treeView = new TreeView({});

      await treeView.revealPath(__dirname);

      expect(treeView.selectedEntry()?.getPath()).toBe(__dirname);
      expect(treeView.selectedEntry()?.isExpanded).toBe(true);
    });
  });

  describe("the selection a package reads", () => {
    it("leaves out the section header, which is a label rather than a path", () => {
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
      });

      treeView.selectEntry(section.root);
      treeView.selectMultipleEntries(section.entries[0]);

      expect(treeView.selectedPaths()).toEqual([__filename]);
    });
  });

  describe("copying the selected entry's path", () => {
    beforeEach(() => {
      spyOn(lumine.clipboard, "write");
    });

    it("copies the path the first time an entry is selected", () => {
      treeView = new TreeView({});
      const root = treeView.roots[0];

      treeView.selectEntry(root);
      treeView.copySelectedEntryPath();

      expect(lumine.clipboard.write).toHaveBeenCalledWith(root.getPath());
    });

    it("copies the path of the entry a multiple selection ended on", async () => {
      treeView = new TreeView({});
      await treeView.revealPath(__filename);
      const file = treeView.selectedEntry();

      treeView.selectEntry(treeView.roots[0]);
      treeView.selectMultipleEntries(file);
      treeView.copySelectedEntryPath();

      expect(lumine.clipboard.write).toHaveBeenCalledWith(__filename);
    });

    it("copies a path relative to the project folder holding it", async () => {
      treeView = new TreeView({});
      await treeView.revealPath(__filename);

      treeView.copySelectedEntryPath(true);

      expect(lumine.clipboard.write).toHaveBeenCalledWith(
        path.join("spec", path.basename(__filename)),
      );
    });

    it("leaves the clipboard alone for a project folder, which relativizes to nothing", () => {
      treeView = new TreeView({});

      treeView.selectEntry(treeView.roots[0]);
      treeView.copySelectedEntryPath(true);

      expect(lumine.clipboard.write).not.toHaveBeenCalled();
    });

    it("leaves the clipboard alone for a section header, which owns no path", () => {
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
      });

      treeView.selectEntry(section.root);
      treeView.copySelectedEntryPath();

      expect(lumine.clipboard.write).not.toHaveBeenCalled();
    });
  });

  describe("opening the selected entry in this window", () => {
    beforeEach(() => {
      spyOn(lumine.project, "setState");
      spyOn(lumine.app, "openWindow");
    });

    it("hands the folder to the project rather than opening a window", () => {
      treeView = new TreeView({});
      const root = treeView.roots[0];

      treeView.selectEntry(root);
      treeView.openSelectedEntryInThisWindow();

      expect(lumine.project.setState).toHaveBeenCalledWith([root.getPath()]);
      expect(lumine.app.openWindow).not.toHaveBeenCalled();
    });

    // The project resolves a file to the directory holding it, so the command
    // reads the same wherever it is invoked from.
    it("passes a file's own path along, leaving the project to resolve it", async () => {
      treeView = new TreeView({});
      await treeView.revealPath(__filename);

      treeView.openSelectedEntryInThisWindow();

      expect(lumine.project.setState).toHaveBeenCalledWith([__filename]);
    });

    it("does nothing for an entry that owns no path", () => {
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
      });

      treeView.selectEntry(section.root);
      treeView.openSelectedEntryInThisWindow();

      expect(lumine.project.setState).not.toHaveBeenCalled();
    });
  });

  describe("the context menu of a project folder", () => {
    let pack, disposable;

    const openMenu = () => {
      const packagePath = path.resolve(__dirname, "..");
      pack = lumine.packages.loadPackage(packagePath);
      expect(pack.path).toBe(packagePath);
      const [, menu] = pack.menus.find(([menuPath]) => menuPath.endsWith("tree-view-plus.json"));
      disposable = lumine.contextMenu.add(menu["context-menu"]);

      treeView = new TreeView({});
      lumine.workspace.getLeftDock().getActivePane().getElement().appendChild(treeView.element);
      jasmine.attachToDOM(lumine.workspace.getElement());
      return treeView.elementForTreeEntry(treeView.roots[0]).querySelector(":scope > .header");
    };

    const labels = (element) =>
      lumine.contextMenu
        .templateForElement(element)
        .filter((item) => item.visible !== false)
        .map((item) => item.label);

    afterEach(() => {
      disposable?.dispose();
      if (pack) lumine.packages.unloadPackage(pack.name);
      disposable = pack = null;
    });

    it("claims the project-relative path item so the whole-tree menu cannot offer it", () => {
      const rootHeader = openMenu();

      expect(labels(rootHeader)).toContain("Copy Full Path");
      expect(labels(rootHeader)).not.toContain("Copy Project Path");
      expect(labels(treeView.list)).toContain("Copy Project Path");
    });

    // The path items go last on purpose: a platform-specific "Show in
    // Explorer" comes from a selector of its own, which can only append after
    // everything the menus above contribute.
    it("keeps the items that act on the project in one run", () => {
      const rootHeader = openMenu();
      const shown = labels(rootHeader);
      const at = (label) => shown.indexOf(label);

      const project = [
        "Add Project Folder",
        "Remove Project Folder",
        "Collapse All Project Folders",
        "Open in New Window",
        "Open in This Window",
      ];
      for (const label of project) expect(at(label)).toBeGreaterThan(-1);
      expect(project.map(at)).toEqual(project.map((_, i) => at(project[0]) + i));

      expect(at("Copy Full Path")).toBeGreaterThan(at("Open in This Window"));
    });

    it("keeps the same run for a right-click anywhere else in the tree", () => {
      openMenu();
      const shown = labels(treeView.list);
      const at = (label) => shown.indexOf(label);

      expect(at("Open in New Window")).toBe(at("Add Project Folder") + 1);
      expect(at("Open in This Window")).toBe(at("Add Project Folder") + 2);
      expect(at("Copy Full Path")).toBeGreaterThan(at("Open in This Window"));
      expect(at("Copy Project Path")).toBe(at("Copy Full Path") + 1);
    });
  });

  describe("the context menu marker for a virtual selection", () => {
    it("marks the list only while every selected row is virtual", () => {
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
      });

      treeView.selectEntry(section.entries[0]);
      treeView.showFullMenu();
      expect(treeView.list).toHaveClass("special-select");

      treeView.selectEntry(treeView.roots[0]);
      treeView.showFullMenu();
      expect(treeView.list).not.toHaveClass("special-select");
    });
  });
});

describe("TreeView row model and sticky headers", () => {
  function item(name) {
    const entryPath = path.join("/root", name);
    return {
      name,
      path: entryPath,
      status: null,
      isPathEqual: (candidate) => candidate === entryPath,
      contains: () => false,
    };
  }

  function entry(treeView, name, kind, parent = null, options = {}) {
    const result = new TreeEntry(treeView, {
      item: item(name),
      kind,
      parent,
      ...options,
    });
    if (parent) parent.children.push(result);
    result.isExpanded = kind === "directory";
    return result;
  }

  function layout(treeView, roots, regularHeight = 24, rootHeight = 32) {
    const rows = [];
    const tops = [0];
    const append = (current, depth) => {
      current.depth = depth;
      current.index = rows.length;
      current.top = tops[tops.length - 1];
      current.height = current.projectRoot ? rootHeight : regularHeight;
      rows.push(current);
      tops.push(current.top + current.height);
      if (current.kind === "directory" && current.isExpanded) {
        for (const child of current.children) append(child, depth + 1);
      }
      current.subtreeEndIndex = rows.length;
    };
    for (const root of roots) append(root, 0);
    treeView.visibleRows = rows;
    treeView.rowTops = tops;
  }

  function stickyHarness() {
    const treeView = Object.create(TreeView.prototype);
    treeView.stickyHeadersEnabled = true;
    treeView.scroller = document.createElement("div");
    // The sticky pipeline reads the cached scroll position, never the element,
    // so scrolling the harness means writing here.
    treeView.scrollPosition = { top: 0, left: 0 };
    treeView.list = document.createElement("ol");
    treeView.list.style.width = "300px";
    treeView.selectedEntries = new Set();
    return treeView;
  }

  it("keeps the root stable from the first scroll position and derives nested stickies from offsets", () => {
    const treeView = stickyHarness();
    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const source = entry(treeView, "source", "directory", root);
    const components = entry(treeView, "components", "directory", source);
    entry(treeView, "button.js", "file", components);
    layout(treeView, [root]);

    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual(["root"]);

    treeView.scrollPosition.top = 1;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual([
      "root",
      "source",
      "components",
    ]);
  });

  it("unpins a directory exactly when its final descendant leaves its sticky slot", () => {
    const treeView = stickyHarness();
    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const directory = entry(treeView, "source", "directory", root);
    entry(treeView, "last.js", "file", directory);
    layout(treeView, [root]);

    treeView.scrollPosition.top = 47;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual([
      "root",
      "source",
    ]);

    treeView.scrollPosition.top = 48;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual(["root"]);
  });

  it("pushes an ending sticky directory upward before its next sibling", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const directory = entry(treeView, "source", "directory", root);
    entry(treeView, "last.js", "file", directory);
    entry(treeView, "next-directory", "directory", root);
    layout(treeView, [root]);

    treeView.scrollPosition.top = 25;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());

    expect(treeView.stickyHeaderList.children.length).toBe(2);
    expect(treeView.stickyHeaderList.children[1].style.top).toBe("-1px");
    expect(treeView.stickyHeaderList.children[0].style.zIndex).toBe("2");
    expect(treeView.stickyHeaderList.children[1].style.zIndex).toBe("1");

    treeView.scrollPosition.top = 47;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());
    expect(treeView.stickyHeaderList.children[1].style.top).toBe("-23px");

    treeView.scrollPosition.top = 48;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());
    expect(treeView.stickyHeaderList.children.length).toBe(1);
    treeView.clearStickyHeaderViews();
  });

  it("shrinks the sticky list with a departing header instead of covering the reveal", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const documents = entry(treeView, "documents", "directory", root);
    entry(treeView, "a.txt", "file", documents);
    entry(treeView, "b.txt", "file", documents);
    const sibling = entry(treeView, "bcdr", "directory", root);
    entry(treeView, "main.ipy", "file", sibling);
    layout(treeView, [root]);

    treeView.scrollPosition.top = 60;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());

    expect(treeView.stickyHeaderList.children.length).toBe(2);
    expect(treeView.stickyHeaderList.children[1].style.top).toBe("-12px");
    // The departing header's subtree ends 44px below the viewport top, so the
    // opaque list must end there too. At the summed 56px, a dead band below
    // the pushed header blankets the top of the sibling row sliding in — one
    // band per simultaneously departing header.
    expect(treeView.stickyHeaderList.style.height).toBe("44px");
    treeView.clearStickyHeaderViews();
  });

  it("switches roots from logical row boundaries without reading layout geometry", () => {
    const treeView = stickyHarness();
    const first = entry(treeView, "first", "directory", null, { projectRoot: true });
    entry(treeView, "one.js", "file", first);
    const second = entry(treeView, "second", "directory", null, { projectRoot: true });
    entry(treeView, "two.js", "file", second);
    layout(treeView, [first, second]);

    treeView.scrollPosition.top = second.top;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual(["second"]);
  });

  it("updates immediately on scroll instead of waiting for another animation frame", () => {
    const treeView = {
      stickyHeadersEnabled: true,
      stickyHeaderUpdateFrame: 42,
      updateStickyHeaderOverlay: jasmine.createSpy("updateStickyHeaderOverlay"),
    };
    spyOn(window, "cancelAnimationFrame");

    TreeView.prototype.updateStickyHeadersOnScroll.call(treeView);

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(treeView.stickyHeaderUpdateFrame).toBeNull();
    expect(treeView.updateStickyHeaderOverlay).toHaveBeenCalled();
  });

  it("clips sticky paint to the scrollport before the scrollbar", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.contentWidth = 300;
    treeView.scrollportWidth = 284;
    treeView.renderStickyHeaderEntries = jasmine.createSpy("renderStickyHeaderEntries");
    treeView.collectStickyHeaderEntries = jasmine
      .createSpy("collectStickyHeaderEntries")
      .and.returnValue([]);

    treeView.updateStickyHeaderOverlay();

    expect(treeView.stickyHeaderList.style.left).toBe("0px");
    expect(treeView.stickyHeaderList.style.width).toBe("300px");
    expect(treeView.stickyHeaderList.style.clipPath).toBe("inset(0px 16px 0px 0px)");

    treeView.contentWidth = 400;
    treeView.scrollPosition.left = 30;
    treeView.updateStickyHeaderOverlay();

    expect(treeView.stickyHeaderList.style.left).toBe("-30px");
    expect(treeView.stickyHeaderList.style.width).toBe("400px");
    expect(treeView.stickyHeaderList.style.clipPath).toBe("inset(0px 86px 0px 30px)");
  });

  it("renders sticky rows from the same logical entry without source-row handoffs", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    root.height = 32;
    root.depth = 0;

    treeView.renderStickyHeaderEntries([root]);
    const stickyElement = treeView.stickyHeaderList.firstElementChild;
    expect(stickyElement.treeEntry).toBe(root);
    expect(stickyElement.classList.contains("tree-view-sticky-header")).toBe(true);
    expect(treeView.treeEntryForElement(stickyElement.firstElementChild)).toBe(root);

    treeView.selectedEntries.add(root);
    root.item.status = "modified";
    treeView.renderStickyHeaderEntries([root]);
    expect(treeView.stickyHeaderList.firstElementChild).toBe(stickyElement);
    expect(stickyElement.classList.contains("selected")).toBe(true);
    expect(stickyElement.classList.contains("status-modified")).toBe(true);

    treeView.renderStickyHeaderEntries([]);
    expect(treeView.stickyHeaderLayer.hidden).toBe(true);
    expect(root.views.size).toBe(0);
  });

  it("refreshes a reused sticky row when the measured row grid changes", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    root.height = 32;
    root.depth = 0;

    treeView.renderStickyHeaderEntries([root]);
    const stickyElement = treeView.stickyHeaderList.firstElementChild;
    expect(stickyElement.style.height).toBe("32px");
    expect(treeView.stickyHeaderList.style.height).toBe("32px");

    // A stylesheet arriving after the sticky mounted re-measured the rows.
    // The copy is in the stable prefix, so it is reused, not recreated — it
    // must follow the new grid the way renderVisibleRows refreshes real rows.
    root.height = 24;
    treeView.renderStickyHeaderEntries([root]);

    expect(treeView.stickyHeaderList.firstElementChild).toBe(stickyElement);
    expect(stickyElement.style.height).toBe("24px");
    expect(treeView.stickyHeaderList.style.height).toBe("24px");
    treeView.clearStickyHeaderViews();
  });

  it("keeps the stable sticky prefix mounted when a nested directory joins the stack", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const source = entry(treeView, "source", "directory", root);
    root.height = 32;
    source.height = 24;

    treeView.renderStickyHeaderEntries([root]);
    const rootElement = treeView.stickyHeaderList.firstElementChild;
    treeView.renderStickyHeaderEntries([root, source]);

    expect(treeView.stickyHeaderList.firstElementChild).toBe(rootElement);
    expect(treeView.stickyHeaderList.lastElementChild.treeEntry).toBe(source);
    treeView.clearStickyHeaderViews();
  });

  it("keeps every visible row mounted while scrolling", () => {
    const treeView = stickyHarness();
    treeView.stickyHeadersEnabled = false;
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];
    treeView.rowViews = new Map();
    treeView.specialRoots = [];
    treeView.contentWidth = 0;
    treeView.regularRowHeight = 24;
    treeView.list = document.createElement("ol");
    Object.defineProperty(treeView.scroller, "clientWidth", { value: 300 });

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    for (let index = 0; index < 100; index++) {
      entry(treeView, `file-${index}.js`, "file", root);
    }
    layout(treeView, [root]);

    treeView.renderVisibleRows();
    const initialElements = new Map(
      Array.from(treeView.rowViews, ([row, view]) => [row, view.element]),
    );
    expect(treeView.rowViews.size).toBe(treeView.visibleRows.length);

    treeView.scrollPosition.top = 12000;
    treeView.updateStickyHeaderOverlay();
    expect(treeView.rowViews.size).toBe(treeView.visibleRows.length);
    for (const [row, element] of initialElements) {
      expect(treeView.rowViews.get(row).element).toBe(element);
    }
    treeView.destroyRowViews();
  });

  it("keeps the package-owned state and clears the overlay when disabled", () => {
    const treeView = {
      element: document.createElement("div"),
      scheduleStickyHeadersUpdate: jasmine.createSpy("scheduleStickyHeadersUpdate"),
      renderStickyHeaderEntries: jasmine.createSpy("renderStickyHeaderEntries"),
    };

    TreeView.prototype.setStickyHeadersEnabled.call(treeView, true);
    expect(treeView.element.classList.contains("sticky-headers")).toBe(true);
    expect(treeView.scheduleStickyHeadersUpdate).toHaveBeenCalled();

    TreeView.prototype.setStickyHeadersEnabled.call(treeView, false);
    expect(treeView.element.classList.contains("sticky-headers")).toBe(false);
    expect(treeView.renderStickyHeaderEntries).toHaveBeenCalledWith([]);
  });

  it("keeps scrolling and sticky paint in separate surfaces", () => {
    const stylesheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "tree-view-plus.css"),
    );
    const tree = document.createElement("div");
    tree.classList.add("tree-view");
    tree.tabIndex = -1;
    tree.style.cssText = `
      --tree-view-background-color: rgb(242, 242, 242);
      --tree-view-sticky-background: rgb(242, 242, 242);
      --background-color-selected: rgb(220, 225, 235);
      --button-background-color-selected: rgb(90, 138, 233);
      --ui-line-height: 24px;
      --ui-tab-height: 32px;
      --ui-size: 12px;
      --component-padding: 8px;
      --component-icon-padding: 5px;
      --disclosure-arrow-size: 12px;
      --tree-view-row-inset: 4px;
      --tree-view-row-border-radius: 6px;
    `;

    const viewport = document.createElement("div");
    viewport.classList.add("tree-view-viewport");
    const scroller = document.createElement("div");
    scroller.classList.add("tree-view-scroller");
    const list = document.createElement("ol");
    list.classList.add("tree-view-root", "list-tree", "has-collapsable-children");
    const file = document.createElement("li");
    file.classList.add("file", "entry", "list-item", "tree-view-row", "selected");
    file.style.setProperty("--tree-view-depth", "1");
    const fileName = document.createElement("span");
    fileName.classList.add("name");
    fileName.textContent = "styles.css";
    file.appendChild(fileName);

    const directory = document.createElement("li");
    directory.classList.add("directory", "entry", "list-nested-item", "tree-view-row", "expanded");
    directory.style.setProperty("--tree-view-depth", "1");
    const directoryRow = document.createElement("div");
    directoryRow.classList.add("header", "list-item");
    const directoryName = document.createElement("span");
    directoryName.classList.add("name");
    directoryName.textContent = "Source";
    directoryRow.appendChild(directoryName);
    directory.appendChild(directoryRow);

    const root = document.createElement("li");
    root.classList.add(
      "directory",
      "entry",
      "list-nested-item",
      "tree-view-row",
      "project-root",
      "expanded",
      "selected",
    );
    root.style.setProperty("--tree-view-depth", "0");
    const rootHeader = document.createElement("div");
    rootHeader.classList.add("header", "list-item", "project-root-header");
    const rootName = document.createElement("span");
    rootName.classList.add("name");
    rootName.textContent = "project";
    rootHeader.appendChild(rootName);
    root.appendChild(rootHeader);

    list.append(root, file, directory);
    scroller.appendChild(list);

    const stickyLayer = document.createElement("div");
    stickyLayer.classList.add("tree-view-sticky-header-layer");
    const stickyList = document.createElement("ol");
    stickyList.classList.add(
      "tree-view-sticky-header-list",
      "list-tree",
      "has-collapsable-children",
    );
    stickyList.style.height = "24px";
    const stickyEntry = document.createElement("li");
    stickyEntry.classList.add(
      "tree-view-sticky-header",
      "directory",
      "list-nested-item",
      "selected",
    );
    stickyEntry.style.setProperty("--tree-view-depth", "1");
    const stickyRow = document.createElement("div");
    stickyRow.classList.add("tree-view-sticky-header-row", "header", "list-item");
    const stickyName = document.createElement("span");
    stickyName.classList.add("name");
    stickyName.textContent = "Source";
    stickyRow.appendChild(stickyName);
    stickyEntry.appendChild(stickyRow);
    stickyList.appendChild(stickyEntry);
    stickyLayer.appendChild(stickyList);
    viewport.append(scroller, stickyLayer);
    tree.appendChild(viewport);
    jasmine.attachToDOM(tree);

    try {
      expect(getComputedStyle(tree).overflow).toBe("hidden");
      expect(getComputedStyle(scroller).overflow).toBe("auto");
      expect(getComputedStyle(file).marginLeft).toBe("0px");
      expect(getComputedStyle(fileName).position).toBe("relative");
      expect(getComputedStyle(file, "::before").backgroundColor).toBe("rgb(220, 225, 235)");
      expect(getComputedStyle(stickyLayer).position).toBe("absolute");
      expect(getComputedStyle(stickyLayer).height).toBe("0px");
      expect(getComputedStyle(stickyList).overflow).toBe("hidden");
      expect(getComputedStyle(stickyList).contain).toBe("paint");
      expect(getComputedStyle(stickyList).transform).toBe("none");
      expect(getComputedStyle(stickyList).backgroundColor).toBe("rgb(242, 242, 242)");
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(220, 225, 235)");
      const directoryRowStyle = getComputedStyle(directoryRow);
      const stickyRowStyle = getComputedStyle(stickyRow);
      const directoryDisclosureLeft =
        directoryRow.getBoundingClientRect().left + parseFloat(directoryRowStyle.paddingLeft);
      const stickyDisclosureLeft =
        stickyRow.getBoundingClientRect().left + parseFloat(stickyRowStyle.paddingLeft);
      // The indent lives on the row `li` as padding, not on the header — the
      // header itself starts at the li's content edge.
      expect(getComputedStyle(directory).paddingLeft).toBe("22px");
      expect(directoryRowStyle.marginLeft).toBe("0px");
      expect(stickyDisclosureLeft).toBe(directoryDisclosureLeft);
      // The root header takes its height from --tree-view-root-header-height
      // (tab height here), not from the generic list line-height — the rule
      // reading the variable loses that fight without the :not(.project-root)
      // exclusion, and the variable is silently dead.
      expect(getComputedStyle(rootHeader).lineHeight).toBe("32px");
      expect(rootHeader.getBoundingClientRect().height).toBe(32);
      expect(getComputedStyle(directoryRow).lineHeight).toBe("24px");
      // The selection layer is as tall as the row it paints, whichever height
      // that row happens to be, because it takes it from the row rather than
      // restating it from a variable. The rule that named --ui-line-height used
      // to win the tie against the one naming --tree-view-root-header-height,
      // leaving a selected root's highlight 8px short of its own row.
      expect(getComputedStyle(root, "::before").height).toBe("32px");
      expect(root.getBoundingClientRect().height).toBe(32);
      expect(getComputedStyle(file, "::before").height).toBe("24px");
      expect(file.getBoundingClientRect().height).toBe(24);
      expect(stickyName.getBoundingClientRect().top - stickyEntry.getBoundingClientRect().top).toBe(
        directoryName.getBoundingClientRect().top - directory.getBoundingClientRect().top,
      );
      expect(stickyRow.getBoundingClientRect().height).toBe(
        directoryRow.getBoundingClientRect().height,
      );

      tree.focus();
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(90, 138, 233)");
    } finally {
      stylesheet.dispose();
    }
  });

  it("joins adjacent rounded selections into continuous areas", () => {
    const stylesheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "tree-view-plus.css"),
    );
    const tree = document.createElement("div");
    tree.classList.add("tree-view");
    tree.style.cssText = `
      --tree-view-row-border-radius: 6px;
      --tree-view-row-inset: 4px;
      --ui-line-height: 24px;
    `;
    const list = document.createElement("ol");
    list.classList.add("tree-view-root", "list-tree");

    const row = (...classNames) => {
      const element = document.createElement("li");
      element.classList.add("entry", "tree-view-row", ...classNames);
      return element;
    };
    const first = row("selected");
    const middle = row("selected");
    const last = row("selected");
    const isolated = row("selected");
    const dragTarget = row("selected", "drag-over");
    const afterDragTarget = row("selected");
    list.append(first, middle, last, row(), isolated, row(), dragTarget, afterDragTarget);

    const stickyList = document.createElement("ol");
    stickyList.classList.add("tree-view-sticky-header-list", "list-tree");
    const sticky = () => {
      const entry = document.createElement("li");
      entry.classList.add("entry", "tree-view-sticky-header", "selected");
      const header = document.createElement("div");
      header.classList.add("tree-view-sticky-header-row");
      entry.appendChild(header);
      return { entry, header };
    };
    const firstSticky = sticky();
    const lastSticky = sticky();
    stickyList.append(firstSticky.entry, lastSticky.entry);
    tree.append(list, stickyList);
    jasmine.attachToDOM(tree);

    try {
      const selectionStyle = (entry) => getComputedStyle(entry, "::before");

      expect(selectionStyle(first).borderTopLeftRadius).toBe("6px");
      expect(selectionStyle(first).borderBottomLeftRadius).toBe("0px");
      expect(selectionStyle(middle).borderTopLeftRadius).toBe("0px");
      expect(selectionStyle(middle).borderBottomLeftRadius).toBe("0px");
      expect(selectionStyle(last).borderTopLeftRadius).toBe("0px");
      expect(selectionStyle(last).borderBottomLeftRadius).toBe("6px");
      expect(selectionStyle(isolated).borderRadius).toBe("6px");
      expect(selectionStyle(dragTarget).borderRadius).toBe("6px");
      expect(selectionStyle(afterDragTarget).borderRadius).toBe("6px");

      expect(getComputedStyle(firstSticky.header).borderTopLeftRadius).toBe("6px");
      expect(getComputedStyle(firstSticky.header).borderBottomLeftRadius).toBe("0px");
      expect(getComputedStyle(lastSticky.header).borderTopLeftRadius).toBe("0px");
      expect(getComputedStyle(lastSticky.header).borderBottomLeftRadius).toBe("6px");
    } finally {
      tree.remove();
      stylesheet.dispose();
    }
  });

  // The list sizes itself, rather than script writing back the widest row it
  // measured: a row is `min-width: 100%` of the list, so a measured maximum
  // fed back into the list width can only ever grow.
  it("follows a long row's width back down when the row goes away", () => {
    const stylesheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "tree-view-plus.css"),
    );
    const tree = document.createElement("div");
    tree.classList.add("tree-view");
    tree.style.cssText = `
      width: 200px;
      height: 300px;
      --ui-line-height: 24px;
      --ui-size: 12px;
      --component-padding: 8px;
      --component-icon-padding: 5px;
      --disclosure-arrow-size: 12px;
    `;

    const viewport = document.createElement("div");
    viewport.classList.add("tree-view-viewport");
    const scroller = document.createElement("div");
    scroller.classList.add("tree-view-scroller");
    const list = document.createElement("ol");
    list.classList.add("tree-view-root", "list-tree", "has-collapsable-children");

    function row(name) {
      const element = document.createElement("li");
      element.classList.add("file", "entry", "list-item", "tree-view-row");
      element.style.setProperty("--tree-view-depth", "0");
      const label = document.createElement("span");
      label.classList.add("name");
      label.textContent = name;
      element.appendChild(label);
      return element;
    }

    // A root section is its own list nested in the tree, and it no longer gets
    // a width written onto it either.
    const section = document.createElement("ol");
    section.classList.add("recent", "tree-view-special", "list-tree", "has-collapsable-children");
    const sectionRow = row("b.js");
    section.appendChild(sectionRow);

    const short = row("a.js");
    const long = row(`${"long-".repeat(20)}name.js`);
    list.append(section, short, long);
    scroller.appendChild(list);
    viewport.appendChild(scroller);
    tree.appendChild(viewport);
    jasmine.attachToDOM(tree);

    try {
      const available = scroller.clientWidth;
      const overflowing = list.getBoundingClientRect().width;
      expect(overflowing).toBeGreaterThan(available);
      // Short rows still stretch across the whole scrollable width, so hover
      // and selection do not stop at the end of the name.
      expect(short.getBoundingClientRect().width).toBe(overflowing);
      expect(section.getBoundingClientRect().width).toBe(overflowing);
      expect(sectionRow.getBoundingClientRect().width).toBe(overflowing);

      long.remove();

      expect(list.getBoundingClientRect().width).toBe(available);
      expect(short.getBoundingClientRect().width).toBe(available);
      expect(sectionRow.getBoundingClientRect().width).toBe(available);
    } finally {
      stylesheet.dispose();
    }
  });
});
