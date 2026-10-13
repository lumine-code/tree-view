const path = require("node:path");
const { CompositeDisposable } = require("lumine");

describe("Tree View Open With", () => {
  let tree, selected, catalog, openers;

  beforeEach(() => {
    jasmine.useRealClock();
    lumine.project.setPaths([]);
    const TreeView = require("../lib/tree-view");
    tree = new TreeView();
    lumine.workspace.getLeftDock().getActivePane().getElement().appendChild(tree.element);
    jasmine.attachToDOM(lumine.workspace.getElement());
    selected = [{ kind: "file", getPath: () => __filename }];
    spyOn(tree, "getSelectedEntries").and.callFake(() => selected);
    openers = [
      { id: "jupyter-view:notebook", label: "Jupyter View", isDefault: true },
      { id: "text-editor", label: "Text Editor", isDefault: false },
    ];
    catalog = spyOn(lumine.workspace, "getAvailableFileOpeners").and.returnValue(openers);
  });

  afterEach(async () => {
    await tree.destroy();
    tree.element.remove();
  });

  it("selects the effective default first and gives only that row a right badge", async () => {
    const host = await tree.openWithSelectedEntry();
    const list = host.getModel();

    expect(list.getItems()).toEqual(openers);
    expect(list.getSelectedItem()).toBe(openers[0]);
    const rows = list.getElement().querySelectorAll('[role="option"]');
    expect(rows[0].textContent).toContain("Jupyter View");
    expect(rows[0].querySelector(".badge").textContent).toBe("Default");
    expect(rows[1].textContent).toContain("Text Editor");
    expect(rows[1].querySelector(".badge")).toBeNull();
    expect(host.window).toBe(lumine.workspace.getWindowForElement(tree.element));
  });

  it("opens the captured file in its original pane with the chosen view", async () => {
    const pane = lumine.workspace.getMainWindow().getEditorContainer().getActivePane();
    const host = await tree.openWithSelectedEntry();
    const list = host.getModel();
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    selected = [{ kind: "file", getPath: () => path.join(__dirname, "other.ipynb") }];
    await list.selectItemById("text-editor");
    const result = await list.runAction("tree-view:open-with-selected-opener");

    expect(result.status).toBe("success");
    expect(open).toHaveBeenCalledOnceWith(__filename, {
      pane,
      searchAllPanes: lumine.config.get("tree-view.alwaysOpenExisting"),
      opener: "text-editor",
      signal: result.signal,
    });
    expect(host.isDestroyed()).toBe(true);
    expect(tree.openWithListHost).toBeNull();
  });

  it("refuses folders and multiple selections while an absent selection stays silent", async () => {
    const warning = spyOn(lumine.notifications, "addWarning");
    selected = [];
    await tree.openWithSelectedEntry();
    expect(warning).not.toHaveBeenCalled();
    selected = [{ kind: "directory", getPath: () => __dirname }];
    await tree.openWithSelectedEntry();
    selected = [
      { kind: "file", getPath: () => __filename },
      { kind: "file", getPath: () => path.join(__dirname, "other.ipynb") },
    ];
    await tree.openWithSelectedEntry();

    expect(warning.calls.count()).toBe(2);
    expect(catalog).not.toHaveBeenCalled();
    expect(tree.openWithListHost).toBeUndefined();
  });

  it("disposes the native picker after cancellation and when the tree retires", async () => {
    const first = await tree.openWithSelectedEntry();
    first.cancel();
    expect(first.isDestroyed()).toBe(true);
    expect(tree.openWithListHost).toBeNull();
    const second = await tree.openWithSelectedEntry();
    await tree.destroy();

    expect(second.isDestroyed()).toBe(true);
    expect(second.getModel().isDestroyed()).toBe(true);
    expect(tree.openWithListHost).toBeNull();
  });

  for (const retirement of ["cancelling the picker", "destroying the tree"]) {
    it(`cancels construction without presenting the late viewer when ${retirement}`, async () => {
      let release, started;
      const constructing = new Promise((resolve) => (release = resolve));
      const began = new Promise((resolve) => (started = resolve));
      const viewer = {
        getURI: () => __filename,
        getTitle: () => "Delayed Viewer",
        getElement: () => document.createElement("div"),
        destroy: jasmine.createSpy("destroy delayed viewer"),
      };
      const registration = lumine.workspace.addFileOpener({
        id: "tree-view:delayed-test-viewer",
        label: "Delayed Viewer",
        canOpen: (uri) => uri === __filename,
        open: (_uri, options) => {
          started(options);
          return constructing;
        },
      });
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      catalog.and.returnValue([
        { id: "tree-view:delayed-test-viewer", label: "Delayed Viewer", isDefault: true },
      ]);
      try {
        const host = await tree.openWithSelectedEntry();
        const action = host.getModel().runAction("tree-view:open-with-selected-opener");
        const options = await began;
        if (retirement === "destroying the tree") await tree.destroy();
        else host.cancel();
        const result = await action;

        expect(result.status).toBe("aborted");
        expect(options.signal).toBe(result.signal);
        expect(options.signal.aborted).toBe(true);
        release(viewer);
        await open.calls.mostRecent().returnValue;
        await flushMicrotasks();

        expect(lumine.workspace.paneForItem(viewer)).toBeUndefined();
        expect(viewer.destroy).toHaveBeenCalledTimes(1);
        expect(host.isDestroyed()).toBe(true);
        expect(tree.openWithListHost).toBeNull();
      } finally {
        release(viewer);
        registration.dispose();
      }
    });
  }

  it("does not recreate a picker after a pending discovery outlives the tree", async () => {
    let release;
    catalog.and.returnValue(new Promise((resolve) => (release = resolve)));
    const addSelectList = spyOn(lumine.workspace, "addSelectList").and.callThrough();
    const pending = tree.openWithSelectedEntry();
    await flushMicrotasks();
    await tree.destroy();
    release(openers);
    await pending;

    expect(addSelectList).not.toHaveBeenCalled();
    expect(tree.openWithListHost).toBeNull();
  });

  it("lets a newer file choice replace delayed discovery for the previous file", async () => {
    const discoveries = [];
    catalog.and.callFake(() => new Promise((resolve) => discoveries.push(resolve)));
    const first = tree.openWithSelectedEntry();
    await flushMicrotasks();
    selected = [{ kind: "file", getPath: () => path.join(__dirname, "other.ipynb") }];
    const second = tree.openWithSelectedEntry();
    await flushMicrotasks();
    discoveries[1](openers);
    const host = await second;
    discoveries[0](openers);
    expect(await first).toBeUndefined();
    expect(tree.openWithListHost).toBe(host);
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    await host.getModel().runAction("tree-view:open-with-selected-opener");

    expect(open.calls.mostRecent().args[0]).toBe(path.join(__dirname, "other.ipynb"));
  });
});

describe("Tree View opening context-menu group", () => {
  let tree, file, folder, disposables, external;

  beforeEach(() => {
    jasmine.useRealClock();
    lumine.project.setPaths([]);
    const TreeView = require("../lib/tree-view");
    tree = new TreeView();
    lumine.workspace.getLeftDock().getActivePane().getElement().appendChild(tree.element);
    jasmine.attachToDOM(lumine.workspace.getElement());
    file = document.createElement("li");
    file.className = "entry file";
    file.setAttribute("is", "tree-view-file");
    folder = document.createElement("li");
    folder.className = "entry directory";
    tree.list.append(file, folder);
    const packageMenus = (name) => {
      const pack = lumine.packages.loadPackage(
        name === "tree-view" ? path.resolve(__dirname, "..") : name,
      );
      return pack.menus.find(([menuPath]) => menuPath.endsWith("main.json"))[1]["context-menu"];
    };
    disposables = new CompositeDisposable(lumine.contextMenu.add(packageMenus("tree-view")));
    external = lumine.contextMenu.add(packageMenus("open-external"));
    disposables.add(external);
    const pack = lumine.packages.getLoadedPackage("tree-view");
    for (const [keymapPath, keymap] of pack.keymaps)
      disposables.add(lumine.keymaps.add(keymapPath, keymap));
  });

  afterEach(async () => {
    disposables.dispose();
    await tree.destroy();
    tree.element.remove();
  });

  const template = (element) => lumine.contextMenu.templateForElement(element);
  const openingLabels = (element) => {
    const items = template(element);
    const firstSeparator = items.findIndex((item) => item.type === "separator");
    return (firstSeparator < 0 ? items : items.slice(0, firstSeparator)).map((item) => item.label);
  };

  it("puts the four file opening actions first and shows the Enter hint for Open", () => {
    expect(openingLabels(file)).toEqual([
      "Open",
      "Open With…",
      "Open Externally",
      "Show in Folder",
    ]);
    expect(template(file)[0].keyBindingLabel).toBe("Enter");
  });

  it("keeps Open With limited to one file, including virtual file rows", () => {
    expect(openingLabels(folder)).toEqual(["Open", "Open Externally", "Show in Folder"]);
    file.classList.add("tree-view-special-entry");
    tree.list.classList.add("special-select");
    expect(openingLabels(file)).toEqual([
      "Open",
      "Open With…",
      "Open Externally",
      "Show in Folder",
    ]);
    tree.showMultiSelectMenu();
    expect(openingLabels(file)).toEqual(["Open Externally", "Show in Folder"]);
    expect(template(file).some((item) => item.command === "tree-view:open-with")).toBe(false);
  });

  it("derives a single separator even when external contributions disappear", () => {
    external.dispose();
    const items = template(file);
    expect(openingLabels(file)).toEqual(["Open", "Open With…"]);
    expect(items[2].type).toBe("separator");
    expect(items[3].type).not.toBe("separator");
    expect(items.at(-1).type).not.toBe("separator");
  });
});
