const path = require("path");
const RootDragAndDropHandler = require("../lib/root-drag-and-drop");

class TestDataTransfer {
  constructor() {
    this.data = new Map();
    this.effectAllowed = "uninitialized";
  }

  get types() {
    return Array.from(this.data.keys());
  }

  get items() {
    return this.types.map((type) => ({ kind: "string", type }));
  }

  setData(type, value) {
    this.data.set(type, `${value}`);
  }

  getData(type) {
    return this.data.get(type) ?? "";
  }

  clearData(type) {
    if (type == null) this.data.clear();
    else this.data.delete(type);
  }
}

describe("project-root drag and drop", () => {
  let handler;

  function buildTree(rootPaths, selectedPaths = rootPaths) {
    const element = document.createElement("div");
    const list = document.createElement("ol");
    element.appendChild(list);
    const entriesByElement = new Map();
    const rowsByPath = new Map();
    const roots = rootPaths.map((rootPath, index) => {
      const row = document.createElement("li");
      row.className = "project-root-header";
      list.appendChild(row);
      const root = {
        projectRoot: true,
        directory: { path: rootPath },
        parent: null,
        subtreeEndIndex: index,
        top: index * 20,
      };
      entriesByElement.set(row, root);
      rowsByPath.set(rootPath, row);
      return root;
    });
    const selected = roots.filter((root) => selectedPaths.includes(root.directory.path));
    return {
      element,
      list,
      roots,
      rowTops: roots.map((_, index) => (index + 1) * 20),
      getSelectedEntries: () => selected,
      treeEntryForElement: (target) => entriesByElement.get(target) ?? null,
      elementForTreeEntry: (entry) => rowsByPath.get(entry.directory.path),
    };
  }

  function dropEvent(target, dataTransfer) {
    return {
      target,
      dataTransfer,
      preventDefault: jasmine.createSpy("preventDefault"),
      stopPropagation: jasmine.createSpy("stopPropagation"),
    };
  }

  afterEach(() => handler?.dispose());

  it("publishes every selected root in one canonical transfer session", () => {
    const firstPath = path.resolve("first-project");
    const secondPath = path.resolve("second-project");
    const untouchedPath = path.resolve("untouched-project");
    const treeView = buildTree([firstPath, untouchedPath, secondPath], [firstPath, secondPath]);
    let sessionValue;
    let sessionCallbacks;
    spyOn(lumine.workspaceDrops, "createSession").and.callFake((value, callbacks) => {
      sessionValue = value;
      sessionCallbacks = callbacks;
      return { token: "root-transfer-token" };
    });
    const write = spyOn(lumine.workspaceDrops, "write").and.callThrough();
    spyOn(lumine.project, "getPaths").and.returnValue([secondPath, untouchedPath, firstPath]);
    const setPaths = spyOn(lumine.project, "setPaths");
    const dataTransfer = new TestDataTransfer();
    handler = new RootDragAndDropHandler(treeView);

    handler.onDragStart(dropEvent(treeView.elementForTreeEntry(treeView.roots[0]), dataTransfer));

    expect(sessionValue).toEqual({ paths: [firstPath, secondPath] });
    expect(write).toHaveBeenCalledWith(dataTransfer, {
      kind: "project-roots",
      token: "root-transfer-token",
      effect: "move",
      allowedLocations: ["center"],
      source: { windowId: lumine.window.getId() },
      items: [
        { type: "directory", path: firstPath },
        { type: "directory", path: secondPath },
      ],
    });
    expect(lumine.workspaceDrops.inspect(dataTransfer)?.kind).toBe("project-roots");
    expect(lumine.workspaceDrops.read(dataTransfer)?.items).toEqual([
      { type: "directory", path: firstPath },
      { type: "directory", path: secondPath },
    ]);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(dataTransfer.getData("text/plain")).toBe([firstPath, secondPath].join("\n"));
    expect(dataTransfer.getData("text/uri-list")).toContain("file:///");
    expect(dataTransfer.types.length).toBe(3);
    expect(dataTransfer.types[0]).toMatch(/^application\/x-lumine-drag;/);
    expect(dataTransfer.types.slice(1)).toEqual(["text/plain", "text/uri-list"]);

    sessionCallbacks.commit({}, sessionValue);
    expect(setPaths).toHaveBeenCalledWith([untouchedPath]);
  });

  it("reorders every dragged root locally and settles without committing the move session", async () => {
    const paths = ["a", "b", "c", "d"];
    const treeView = buildTree(paths);
    handler = new RootDragAndDropHandler(treeView);
    handler.windowId = 7;
    const descriptor = {
      kind: "project-roots",
      token: "local-token",
      source: { windowId: 7 },
      items: [
        { type: "directory", path: "b" },
        { type: "directory", path: "d" },
      ],
    };
    const dataTransfer = new TestDataTransfer();
    spyOn(lumine.workspaceDrops, "inspect").and.returnValue({ kind: "project-roots" });
    spyOn(lumine.workspaceDrops, "read").and.returnValue(descriptor);
    const rollback = spyOn(lumine.workspaceDrops, "rollback").and.resolveTo(true);
    const commit = spyOn(lumine.workspaceDrops, "commit").and.resolveTo(true);
    spyOn(lumine.project, "getPaths").and.returnValue(paths);
    const setPaths = spyOn(lumine.project, "setPaths");
    spyOn(handler, "getDropTargetIndex").and.returnValue(4);

    await handler.onDrop(dropEvent(treeView.elementForTreeEntry(treeView.roots[3]), dataTransfer));

    expect(setPaths).toHaveBeenCalledWith(["a", "c", "b", "d"]);
    expect(rollback).toHaveBeenCalledWith(
      "local-token",
      "project roots reordered within their source window",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("inserts every remote root before committing its source session", async () => {
    const treeView = buildTree(["target"]);
    handler = new RootDragAndDropHandler(treeView);
    handler.windowId = 20;
    const descriptor = {
      kind: "project-roots",
      token: "remote-token",
      source: { windowId: 10 },
      items: [
        { type: "directory", path: "first" },
        { type: "directory", path: "second" },
      ],
    };
    const dataTransfer = new TestDataTransfer();
    spyOn(lumine.workspaceDrops, "inspect").and.returnValue({ kind: "project-roots" });
    spyOn(lumine.workspaceDrops, "read").and.returnValue(descriptor);
    spyOn(lumine.workspaceDrops, "rollback").and.resolveTo(true);
    spyOn(lumine.project, "getPaths").and.returnValues(["target"], ["target", "first", "second"]);
    const setPaths = spyOn(lumine.project, "setPaths");
    const commit = spyOn(lumine.workspaceDrops, "commit").and.callFake(() => {
      expect(setPaths).toHaveBeenCalledWith(["target", "first", "second"]);
      return Promise.resolve(true);
    });
    spyOn(handler, "getDropTargetIndex").and.returnValue(1);

    await handler.onDrop(dropEvent(treeView.elementForTreeEntry(treeView.roots[0]), dataTransfer));

    expect(commit).toHaveBeenCalledWith("remote-token", { sourceWindowId: 10 });
  });

  it("does not commit a remote session unless the target retained every root", async () => {
    const treeView = buildTree(["target"]);
    handler = new RootDragAndDropHandler(treeView);
    handler.windowId = 20;
    const descriptor = {
      kind: "project-roots",
      token: "remote-token",
      source: { windowId: 10 },
      items: [{ type: "directory", path: "incoming" }],
    };
    const dataTransfer = new TestDataTransfer();
    spyOn(lumine.workspaceDrops, "inspect").and.returnValue({ kind: "project-roots" });
    spyOn(lumine.workspaceDrops, "read").and.returnValue(descriptor);
    const rollback = spyOn(lumine.workspaceDrops, "rollback").and.resolveTo(true);
    const commit = spyOn(lumine.workspaceDrops, "commit").and.resolveTo(true);
    spyOn(lumine.project, "getPaths").and.returnValues(["target"], ["target"]);
    spyOn(lumine.project, "setPaths");
    spyOn(handler, "getDropTargetIndex").and.returnValue(1);

    let failure;
    try {
      await handler.onDrop(
        dropEvent(treeView.elementForTreeEntry(treeView.roots[0]), dataTransfer),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toBe("The target window could not add every dragged project root");
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledWith(
      "remote-token",
      "The target window could not add every dragged project root",
    );
  });

  it("restores the target roots when the source rejects a remote move", async () => {
    const treeView = buildTree(["target"]);
    handler = new RootDragAndDropHandler(treeView);
    handler.windowId = 20;
    const descriptor = {
      kind: "project-roots",
      token: "remote-token",
      source: { windowId: 10 },
      items: [{ type: "directory", path: "incoming" }],
    };
    const dataTransfer = new TestDataTransfer();
    spyOn(lumine.workspaceDrops, "inspect").and.returnValue({ kind: "project-roots" });
    spyOn(lumine.workspaceDrops, "read").and.returnValue(descriptor);
    spyOn(lumine.workspaceDrops, "rollback").and.resolveTo(false);
    spyOn(lumine.workspaceDrops, "commit").and.resolveTo(false);
    spyOn(lumine.project, "getPaths").and.returnValues(["target"], ["target", "incoming"]);
    const setPaths = spyOn(lumine.project, "setPaths");
    spyOn(handler, "getDropTargetIndex").and.returnValue(1);

    await expectAsync(
      handler.onDrop(dropEvent(treeView.elementForTreeEntry(treeView.roots[0]), dataTransfer)),
    ).toBeRejectedWithError("The source window rejected the project-root transfer");

    expect(setPaths.calls.allArgs()).toEqual([[["target", "incoming"]], [["target"]]]);
  });

  it("clears its insertion marker after a remote drag leaves the tree", async () => {
    const treeView = buildTree(["target"]);
    const emptyScrollerArea = document.createElement("div");
    treeView.element.appendChild(emptyScrollerArea);
    handler = new RootDragAndDropHandler(treeView);
    const dataTransfer = new TestDataTransfer();
    spyOn(lumine.workspaceDrops, "inspect").and.returnValue({ kind: "project-roots" });
    const clearDropTarget = spyOn(handler, "clearDropTarget").and.callThrough();
    handler.getPlaceholder();

    handler.onDragLeave({
      target: treeView.elementForTreeEntry(treeView.roots[0]),
      currentTarget: treeView.element,
      relatedTarget: emptyScrollerArea,
      dataTransfer,
      stopPropagation: jasmine.createSpy("stopPropagation"),
    });
    expect(clearDropTarget).not.toHaveBeenCalled();

    handler.onDragLeave({
      target: emptyScrollerArea,
      currentTarget: treeView.element,
      relatedTarget: document.body,
      dataTransfer,
      stopPropagation: jasmine.createSpy("stopPropagation"),
    });
    await conditionPromise(() => clearDropTarget.calls.count() === 1);

    expect(handler.placeholderEl).toBeNull();
  });
});
