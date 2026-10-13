const path = require("node:path");
const { createRequire } = require("node:module");
const { CompositeDisposable } = require("lumine");

function currentPackageRequire() {
  const pack =
    lumine.packages.getLoadedPackage("tree-view") ??
    lumine.packages.loadPackage(path.resolve(__dirname, ".."));
  return createRequire(path.join(pack.path, "package.json"));
}

describe("Tree View opening context-menu group", () => {
  let tree, file, folder, disposables, external, humanizeKeystroke;

  beforeEach(() => {
    jasmine.useRealClock();
    lumine.project.setPaths([]);
    const TreeView = currentPackageRequire()("./lib/tree-view");
    const coreRequire = createRequire(
      path.join(lumine.application.getResourcePath(), "package.json"),
    );
    ({ humanizeKeystroke } = coreRequire("@lumine-code/underscore-plus"));
    tree = new TreeView();
    lumine.workspace.getLeftDock().getActivePane().getElement().appendChild(tree.element);
    jasmine.attachToDOM(lumine.workspace.getElement());
    file = document.createElement("li");
    file.className = "entry file";
    file.setAttribute("is", "tree-view-file");
    folder = document.createElement("li");
    folder.className = "entry directory collapsed";
    tree.list.append(file, folder);
    const packageMenus = (name) => {
      const pack = lumine.packages.loadPackage(
        name === "tree-view" ? path.resolve(__dirname, "..") : name,
      );
      return pack.menus.find(([menuPath]) => menuPath.endsWith("main.json"))[1]["context-menu"];
    };
    disposables = new CompositeDisposable(
      lumine.contextMenu.add(packageMenus("tree-view")),
      lumine.contextMenu.add(packageMenus("open-with")),
    );
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

  const expectOpeningHint = (element) => {
    const item = template(element)[0];
    expect(item.command).toBe("tree-view:open-selected-entry");
    const [binding] = lumine.keymaps.findKeyBindings({ command: item.command, target: element });
    expect(binding?.selector).toBe(".tree-view");
    expect(binding?.keystrokes).toBe("enter");
    expect(item.keyBindingLabel).toBe(humanizeKeystroke("enter"));
  };

  const expectNoWindowRows = (element) => {
    const items = template(element);
    for (const label of ["Open in New Window", "Open in Detached Window", "Open in This Window"])
      expect(items.some((item) => item.label === label)).toBe(false);
  };

  it("groups file opening first without window actions and shows the Enter hint", () => {
    expect(openingLabels(file)).toEqual([
      "Open",
      "Open With…",
      "Open Externally",
      "Show in Folder",
    ]);
    expect(template(file).find((item) => item.label === "Open With…").command).toBe(
      "open-with:toggle",
    );
    expectOpeningHint(file);
    expectNoWindowRows(file);
  });

  it("offers Open With on folders alongside the appropriate expansion action", () => {
    expect(openingLabels(folder)).toEqual([
      "Expand",
      "Open With…",
      "Open Externally",
      "Show in Folder",
    ]);
    expectOpeningHint(folder);
    expectNoWindowRows(folder);
    folder.classList.replace("collapsed", "expanded");
    expect(openingLabels(folder)).toEqual([
      "Collapse",
      "Open With…",
      "Open Externally",
      "Show in Folder",
    ]);
    expectOpeningHint(folder);
  });

  it("offers Open With for virtual entries and omits it from a multiple selection", () => {
    file.classList.add("tree-view-special-entry");
    tree.list.classList.add("special-select");
    expect(openingLabels(file)).toEqual([
      "Open",
      "Open With…",
      "Open Externally",
      "Show in Folder",
    ]);
    expectNoWindowRows(file);
    tree.showMultiSelectMenu();
    expect(openingLabels(file)).toEqual(["Open Externally", "Show in Folder"]);
    expect(template(file).some((item) => item.command === "open-with:toggle")).toBe(false);
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
