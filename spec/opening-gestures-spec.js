const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { CompositeDisposable } = require("lumine");

describe("Tree View opening gestures", () => {
  let tree, scratch, first, second, folder, previousPaths, disposables, commands, opening;

  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tree-open-gesture-")));
    fs.writeFileSync(path.join(scratch, "first.txt"), "first\n");
    fs.writeFileSync(path.join(scratch, "second.txt"), "second\n");
    fs.mkdirSync(path.join(scratch, "folder"));
    lumine.project.setPaths([scratch]);
    lumine.config.set("tree-view.fileDoubleClick", false);
    lumine.config.set("tree-view.alwaysOpenExisting", false);
    lumine.config.set("core.allowPendingPaneItems", true);
    await lumine.packages.deactivatePackage("open-with");
    await lumine.packages.deactivatePackage("open-external");
    const pack =
      lumine.packages.getLoadedPackage("tree-view") ??
      lumine.packages.loadPackage(path.resolve(__dirname, ".."));
    const TreeView = createRequire(path.join(pack.path, "package.json"))("./lib/tree-view");
    tree = new TreeView();
    lumine.workspace.getLeftDock().getActivePane().getElement().appendChild(tree.element);
    jasmine.attachToDOM(lumine.workspace.getElement());
    await tree.revealPath(path.join(scratch, "first.txt"));
    first = tree.treeEntryForPath(path.join(scratch, "first.txt"));
    second = tree.treeEntryForPath(path.join(scratch, "second.txt"));
    folder = tree.treeEntryForPath(path.join(scratch, "folder"));
    commands = [];
    disposables = new CompositeDisposable(
      lumine.commands.add("lumine-workspace", {
        "open-with:toggle": (event) => {
          event.stopPropagation();
          commands.push({
            command: "open-with:toggle",
            paths: tree.selectedPaths(),
            target: event.target,
          });
        },
        "open-external:open": (event) => {
          event.stopPropagation();
          commands.push({
            command: "open-external:open",
            paths: tree.selectedPaths(),
            target: event.target,
          });
        },
        "open-external:show": (event) => {
          event.stopPropagation();
          commands.push({
            command: "open-external:show",
            paths: tree.selectedPaths(),
            target: event.target,
          });
        },
      }),
    );
    for (const [keymapPath, keymap] of pack.keymaps)
      disposables.add(lumine.keymaps.add(keymapPath, keymap));
    opening = spyOn(lumine.workspace, "open").and.callThrough();
  });

  afterEach(async () => {
    disposables.dispose();
    await tree.destroy();
    tree.element.remove();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Opening gesture scratch directory escaped the temporary root");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function click(target, modifiers = {}) {
    const options = { bubbles: true, cancelable: true, detail: 1, button: 0, ...modifiers };
    for (const type of ["mousedown", "mouseup"])
      target.dispatchEvent(new MouseEvent(type, options));
    const event = new MouseEvent(
      options.button === 0 ? "click" : options.button === 1 ? "auxclick" : "contextmenu",
      options,
    );
    target.dispatchEvent(event);
    return event;
  }

  const nameFor = (entry) => tree.elementForTreeEntry(entry).querySelector(".name");
  const expectCommand = (command, entry) => {
    expect(commands).toEqual([{ command, paths: [entry.getPath()], target: tree.element }]);
    expect(opening).not.toHaveBeenCalled();
    expect(tree.selectedPaths()).toEqual([entry.getPath()]);
    expect(tree.selectOnMouseUp).toBeNull();
    expect(tree.multiSelectEnabled()).toBe(false);
  };

  function registerDefaultViewer() {
    const viewer = {
      element: document.createElement("div"),
      getURI: () => second.getPath(),
      getPath: () => second.getPath(),
      getTitle: () => "Default Viewer",
      destroy() {
        this.element.remove();
      },
    };
    const open = jasmine.createSpy("open default viewer").and.returnValue(viewer);
    disposables.add(
      lumine.workspace.addPathOpener({
        id: "tree-opening-gesture-viewer",
        label: "Default Viewer",
        canOpen: (uri) => uri === second.getPath(),
        open,
        handlesItem: (item) => item === viewer,
      }),
    );
    return { viewer, open };
  }

  it("opens the picker for an Alt left click without changing preview behavior", () => {
    const event = click(nameFor(second), { altKey: true });

    expect(event.defaultPrevented).toBe(true);
    expectCommand("open-with:toggle", second);
  });

  it("opens externally for Ctrl+Alt on a selected row without removing it from a multiple selection", () => {
    tree.selectEntry(first);
    tree.selectMultipleEntries(second);
    tree.showMultiSelectMenuIfNecessary();
    tree.selectOnMouseUp = { cmdKey: true, shiftKey: false };
    click(nameFor(first), { ctrlKey: true, altKey: true });

    expectCommand("open-external:open", first);
  });

  it("selects only the previously unselected Ctrl+Alt target before dispatching externally", () => {
    tree.selectEntry(first);
    click(nameFor(second), { ctrlKey: true, altKey: true });

    expectCommand("open-external:open", second);
  });

  it("adds a range on Ctrl/Cmd+Shift-click through both mouse-down and deferred mouse-up selection", () => {
    tree.selectEntry(folder);
    tree.selectMultipleEntries(first);
    tree.showMultiSelectMenuIfNecessary();
    const range = spyOn(tree, "selectContinuousEntries").and.callThrough();
    const modifiers =
      process.platform === "darwin"
        ? { metaKey: true, shiftKey: true }
        : { ctrlKey: true, shiftKey: true };
    click(nameFor(second), modifiers);

    expect(range).toHaveBeenCalledOnceWith(second, false);
    expect(tree.selectedPaths()).toEqual([folder.getPath(), first.getPath(), second.getPath()]);

    // Clicking an already selected row must also retain entries outside the range.
    click(nameFor(first), modifiers);
    expect(range.calls.count()).toBe(2);
    expect(range.calls.mostRecent().args).toEqual([first, false]);
    expect(tree.selectedPaths()).toEqual([folder.getPath(), first.getPath(), second.getPath()]);
    expect(tree.selectOnMouseUp).toBeNull();
    expect(tree.multiSelectEnabled()).toBe(true);
    expect(opening).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  for (const [modifiers, command] of [
    [{ altKey: true }, "open-with:toggle"],
    [{ altKey: true, ctrlKey: true }, "open-external:open"],
    [{ altKey: true, shiftKey: true }, "open-external:show"],
  ]) {
    it(`routes a directory disclosure to ${command} without expanding it`, () => {
      const toggle = spyOn(folder, "toggleExpansion").and.callThrough();
      const disclosure = tree.elementForTreeEntry(folder).querySelector(".tree-view-disclosure");
      click(disclosure, modifiers);

      expectCommand(command, folder);
      expect(toggle).not.toHaveBeenCalled();
      expect(folder.isExpanded).toBe(false);
    });
  }

  it("uses the logical directory represented by a sticky row", async () => {
    await folder.expand();
    tree.renderStickyHeaderEntries([folder]);
    const sticky = tree.stickyHeaderList.querySelector(".tree-view-sticky-header");
    const toggle = spyOn(folder, "toggleExpansion").and.callThrough();
    click(sticky.querySelector(".name"), { altKey: true, ctrlKey: true });

    expectCommand("open-external:open", folder);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("opens a real path from a special section while keeping its virtual header out of opener gestures", () => {
    const section = tree.addSpecialRoot({
      name: "Recent",
      className: "recent-gesture",
      entryClassName: "recent-gesture-entry",
      getEntries: () => [first.getPath()],
    });
    const pinned = section.entries[0];
    click(nameFor(pinned), { altKey: true });
    expectCommand("open-with:toggle", pinned);
    commands.length = 0;
    click(nameFor(section.root), { altKey: true, ctrlKey: true });

    expect(commands).toEqual([]);
    expect(opening).not.toHaveBeenCalled();
  });

  it("does not fall through to a preview or directory toggle when opening commands are unavailable", () => {
    disposables.dispose();
    const toggle = spyOn(folder, "toggleExpansion").and.callThrough();
    const dispatch = spyOn(lumine.commands, "dispatch").and.callThrough();
    click(nameFor(second), { altKey: true });
    click(nameFor(folder), { ctrlKey: true, altKey: true });
    click(nameFor(second), { shiftKey: true, altKey: true });

    expect(dispatch).toHaveBeenCalledWith(tree.element, "open-with:toggle");
    expect(dispatch).toHaveBeenCalledWith(tree.element, "open-external:open");
    expect(dispatch).toHaveBeenCalledWith(tree.element, "open-external:show");
    expect(opening).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("keeps middle and right clicks out of the opening modifier gestures", () => {
    click(nameFor(second), { button: 1, altKey: true });
    click(nameFor(second), { button: 2, ctrlKey: true, altKey: true });

    expect(commands).toEqual([]);
    expect(opening).not.toHaveBeenCalled();
  });

  for (const allowPending of [true, false]) {
    it(`opens the default viewer on an ordinary click with pending ${allowPending}`, async () => {
      const { viewer, open } = registerDefaultViewer();
      lumine.config.set("core.allowPendingPaneItems", allowPending);
      click(nameFor(second));
      const opened = await opening.calls.mostRecent().returnValue;

      expect(opened).toBe(viewer);
      expect(open).toHaveBeenCalledTimes(1);
      const pane = lumine.workspace.paneForItem(viewer);
      expect(pane.getPendingItem()).toBe(allowPending ? viewer : null);
      expect(commands).toEqual([]);
    });

    it(`selects a file range on Shift-click without opening files when automatic pending is ${allowPending}`, () => {
      const { open } = registerDefaultViewer();
      lumine.config.set("core.allowPendingPaneItems", allowPending);
      tree.selectEntry(first);
      const range = spyOn(tree, "selectContinuousEntries").and.callThrough();
      click(nameFor(second), { shiftKey: true });

      expect(range).toHaveBeenCalledOnceWith(second);
      expect(tree.selectedPaths()).toEqual([first.getPath(), second.getPath()]);
      expect(tree.multiSelectEnabled()).toBe(true);

      // A selected row takes the deferred mouse-up selection path.
      click(nameFor(first), { shiftKey: true });
      expect(range.calls.count()).toBe(2);
      expect(range.calls.mostRecent().args).toEqual([first]);
      expect(tree.selectedPaths()).toEqual([first.getPath()]);
      expect(tree.selectOnMouseUp).toBeNull();
      expect(opening).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
    });
  }

  for (const allowPending of [true, false]) {
    it(`opens the default for Enter with pending ${allowPending}`, async () => {
      const { viewer, open } = registerDefaultViewer();
      lumine.config.set("core.allowPendingPaneItems", allowPending);
      tree.selectEntry(second);
      lumine.commands.dispatch(tree.element, "tree-view:open-selected-entry");
      expect(await opening.calls.mostRecent().returnValue).toBe(viewer);
      expect(lumine.workspace.paneForItem(viewer).getPendingItem()).toBe(
        allowPending ? viewer : null,
      );
      expect(open).toHaveBeenCalledTimes(1);
    });
  }

  it("retains ordinary file double-click mode while the opener gesture acts immediately", async () => {
    const { viewer, open } = registerDefaultViewer();
    lumine.config.set("tree-view.fileDoubleClick", true);
    click(nameFor(second));
    expect(opening).not.toHaveBeenCalled();
    click(nameFor(second), { altKey: true });
    expectCommand("open-with:toggle", second);
    click(nameFor(second), { detail: 2 });

    expect(await opening.calls.mostRecent().returnValue).toBe(viewer);
    expect(lumine.workspace.paneForItem(viewer).getPendingItem()).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps Shift-click range selection for folders without requesting a text editor", () => {
    tree.selectEntry(first);
    const range = spyOn(tree, "selectContinuousEntries").and.callThrough();
    const toggle = spyOn(folder, "toggleExpansion").and.callThrough();
    click(nameFor(folder), { shiftKey: true });

    expect(range).toHaveBeenCalledOnceWith(folder);
    expect(opening).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("adds a clicked directory to the range without toggling it or dispatching a file action", () => {
    tree.selectEntry(second);
    tree.selectMultipleEntries(first);
    const range = spyOn(tree, "selectContinuousEntries").and.callThrough();
    const toggle = spyOn(folder, "toggleExpansion").and.callThrough();
    const modifiers =
      process.platform === "darwin"
        ? { metaKey: true, shiftKey: true }
        : { ctrlKey: true, shiftKey: true };
    click(tree.elementForTreeEntry(folder).querySelector(".tree-view-disclosure"), modifiers);

    expect(range).toHaveBeenCalledOnceWith(folder, false);
    expect(tree.selectedPaths()).toEqual([folder.getPath(), first.getPath(), second.getPath()]);
    expect(opening).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("keeps Enter on the default opener without a separate Shift+Enter action", () => {
    const bindings = lumine.keymaps.findKeyBindings({ target: tree.element, keystrokes: "enter" });
    expect(bindings[0]?.command).toBe("tree-view:open-selected-entry");
    const shifted = lumine.keymaps.findKeyBindings({
      target: tree.element,
      keystrokes: "shift-enter",
    });
    expect(shifted.some((binding) => binding.command.startsWith("tree-view:"))).toBe(false);
  });
});
