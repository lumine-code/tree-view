const path = require("path");
const os = require("os");
const TreeView = require("../lib/tree-view");

describe("TreeView clipboard data", () => {
  it("writes versioned copy metadata for the selected paths", () => {
    const paths = [path.resolve("one.txt"), path.resolve("two.txt")];
    const treeView = { selectedPaths: () => paths };
    spyOn(lumine.clipboard, "writeNativeData").and.returnValue(Promise.resolve(true));

    const handled = TreeView.prototype.performCopyOperation.call(treeView, "cut");

    expect(handled).toBe(true);
    expect(lumine.clipboard.writeNativeData).toHaveBeenCalledWith(
      paths.join(os.EOL),
      "application/lumine-tree-view",
      { version: 1, operation: "cut", paths },
    );
  });

  it("does not touch the clipboard when nothing is selected", () => {
    const treeView = { selectedPaths: () => [] };
    spyOn(lumine.clipboard, "writeNativeData");

    expect(TreeView.prototype.performCopyOperation.call(treeView, "copy")).toBe(false);
    expect(lumine.clipboard.writeNativeData).not.toHaveBeenCalled();
  });

  it("reads tree metadata written by another renderer", async () => {
    const paths = [path.resolve("one.txt")];
    spyOn(lumine.clipboard, "readNativeData").and.returnValue(
      Promise.resolve({ version: 1, operation: "copy", paths }),
    );

    const entry = await TreeView.prototype.readTreeClipboardData.call({});

    expect(lumine.clipboard.readNativeData).toHaveBeenCalledWith("application/lumine-tree-view");
    expect(entry).toEqual({ version: 1, operation: "copy", paths });
  });

  it("rejects unknown versions, operations, and malformed path lists", async () => {
    const readNativeData = spyOn(lumine.clipboard, "readNativeData");
    const rejected = [
      { version: 2, operation: "copy", paths: ["a"] },
      { version: 1, operation: "duplicate", paths: ["a"] },
      { version: 1, operation: "copy", paths: [] },
      { version: 1, operation: "copy", paths: ["a", 7] },
      { version: 1, operation: "copy", paths: ["a", ""] },
      null,
    ];
    for (const data of rejected) {
      readNativeData.and.returnValue(Promise.resolve(data));
      expect(await TreeView.prototype.readTreeClipboardData.call({})).toBeNull();
    }
  });

  it("pastes tree entries before offering the clipboard to other providers", async () => {
    const paths = [path.resolve("one.txt")];
    const targetPath = path.resolve("target");
    const treeView = {
      getPasteTargetPath: () => targetPath,
      readTreeClipboardData: TreeView.prototype.readTreeClipboardData,
      pastePaths: jasmine.createSpy("pastePaths").and.returnValue(true),
    };
    spyOn(lumine.clipboard, "readNativeData").and.returnValue(
      Promise.resolve({ version: 1, operation: "cut", paths }),
    );
    spyOn(lumine.pasteProviders, "handlePaste").and.returnValue(true);

    const handled = await TreeView.prototype.pasteEntries.call(treeView);

    expect(handled).toBe(true);
    expect(treeView.pastePaths).toHaveBeenCalledWith(paths, "cut", targetPath);
    expect(lumine.pasteProviders.handlePaste).not.toHaveBeenCalled();
  });

  it("falls back to paste providers when the clipboard has no tree entry", async () => {
    const targetPath = path.resolve("target");
    const treeView = {
      getPasteTargetPath: () => targetPath,
      readTreeClipboardData: TreeView.prototype.readTreeClipboardData,
      pastePaths: jasmine.createSpy("pastePaths"),
    };
    spyOn(lumine.clipboard, "readNativeData").and.returnValue(Promise.resolve(null));
    spyOn(lumine.pasteProviders, "handlePaste").and.returnValue(true);

    const handled = await TreeView.prototype.pasteEntries.call(treeView);

    expect(handled).toBe(true);
    expect(treeView.pastePaths).not.toHaveBeenCalled();
    expect(lumine.pasteProviders.handlePaste).toHaveBeenCalledWith({
      target: { type: "directory", path: targetPath },
    });
  });

  it("plans every copied path before waiting for the batch", async () => {
    const sourcePaths = [__filename, path.join(__dirname, "tree-view-spec.js")];
    const targetPath = path.resolve("target");
    let resolveBatch;
    const treeView = {
      planCopyEntry: jasmine.createSpy("planCopyEntry").and.callFake((initialPath, newPath) => ({
        initialPath,
        newPath,
      })),
      copyPlans: jasmine.createSpy("copyPlans").and.returnValue(
        new Promise((resolve) => {
          resolveBatch = resolve;
        }),
      ),
    };

    const pastePromise = TreeView.prototype.pastePaths.call(
      treeView,
      sourcePaths,
      "copy",
      targetPath,
    );

    expect(treeView.planCopyEntry.calls.count()).toBe(2);
    expect(treeView.planCopyEntry.calls.argsFor(0)[2].reservedPaths).toBe(
      treeView.planCopyEntry.calls.argsFor(1)[2].reservedPaths,
    );
    expect(treeView.copyPlans).toHaveBeenCalledWith([
      { initialPath: sourcePaths[0], newPath: targetPath },
      { initialPath: sourcePaths[1], newPath: targetPath },
    ]);
    resolveBatch([{ success: true }]);
    expect(await pastePromise).toBe(true);
  });
});
