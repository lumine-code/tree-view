const path = require("path");
const TreeEntry = require("../lib/tree-entry");
const TreeRowView = require("../lib/tree-row-view");

// `data-name`/`data-path` are the anchor packages register per-file context
// menus on. They belong on the row, because a context menu is resolved by
// walking up from whatever was clicked — anything the inner `.name` span
// carries is unreachable unless the pointer is over the text itself.
describe("tree-view entry attributes", () => {
  const treeView = {
    selectedEntries: new Set(),
    expandTreeEntry() {},
    collapseTreeEntry() {},
    reloadTreeEntry() {},
  };
  let views;

  beforeEach(() => {
    views = [];
  });

  afterEach(() => {
    for (const view of views) view.destroy();
  });

  function item(name, entryPath, extra = {}) {
    return {
      name,
      path: entryPath,
      status: null,
      isPathEqual: (candidate) => candidate === entryPath,
      ...extra,
    };
  }

  function mount(kind, entryItem, { depth = 0, ...options } = {}) {
    const entry = new TreeEntry(treeView, { item: entryItem, kind, ...options });
    entry.depth = depth;
    entry.height = 24;
    const view = new TreeRowView(treeView, kind);
    views.push(view);
    view.bind(entry);
    return view;
  }

  it("renders one always-visible indent guide per ancestor", () => {
    const view = mount("file", item("nested.js", path.join("/root", "src", "nested.js")), {
      depth: 2,
    });

    expect(view.indentGuides.parentElement).toBe(view.element);
    expect(view.indentGuides.getAttribute("aria-hidden")).toBe("true");
    expect(view.indentGuides.children.length).toBe(2);
    expect(
      Array.from(view.indentGuides.children).every((guide) =>
        guide.classList.contains("tree-view-indent-guide"),
      ),
    ).toBe(true);

    view.entry.depth = 1;
    view.sync();
    expect(view.indentGuides.children.length).toBe(1);
  });

  it("renders a guide-integrated disclosure only for directories", () => {
    const fileView = mount("file", item("file.js", path.join("/root", "file.js")));
    const directoryView = mount("directory", item("src", path.join("/root", "src")), {
      depth: 2,
    });

    expect(fileView.disclosure).toBeNull();
    expect(directoryView.disclosure.parentElement).toBe(directoryView.element);
    expect(directoryView.disclosure.classList.contains("tree-view-disclosure")).toBe(true);
    expect(directoryView.disclosure.getAttribute("aria-hidden")).toBe("true");
    expect(directoryView.disclosure.style.getPropertyValue("--tree-view-disclosure-depth")).toBe(
      "1",
    );
    expect(directoryView.header.firstElementChild).toBe(directoryView.name);
  });

  it("uses the directory icon area as the disclosure target at depth zero", () => {
    const view = mount("directory", item("root", "/root"));

    expect(view.disclosure.classList.contains("tree-view-root-disclosure")).toBe(true);
    expect(view.disclosure.style.getPropertyValue("--tree-view-disclosure-depth")).toBe("0");
  });

  describe("a file row", () => {
    it("carries them on the `li`, not on the name span", () => {
      const filePath = path.join("/root", "README.md");
      const view = mount("file", item("README.md", filePath));

      expect(view.element.dataset.name).toBe("README.md");
      expect(view.element.dataset.path).toBe(filePath);
      expect(view.name.dataset.name).toBeUndefined();
      expect(view.name.dataset.path).toBeUndefined();
    });

    it("reports the path without reading it back out of the DOM", () => {
      const filePath = path.join("/root", "README.md");
      const view = mount("file", item("README.md", filePath));
      view.name.remove();

      expect(view.element.getPath()).toBe(filePath);
    });

    it("keeps the entry reachable from the mounted row", () => {
      const filePath = path.join("/root", "README.md");
      const view = mount("file", item("README.md", filePath), { depth: 2 });

      expect(view.element.treeEntry).toBe(view.entry);
      expect(view.element.getAttribute("aria-level")).toBe("3");
    });

    it("marks an ignored name without replacing its Git status", () => {
      const filePath = path.join("/root", "debug.log");
      const view = mount(
        "file",
        item("debug.log", filePath, { ignoredByName: true, status: "modified" }),
      );

      expect(view.element.classList.contains("ignored-name")).toBe(true);
      expect(view.element.classList.contains("status-modified")).toBe(true);
    });
  });

  describe("a directory row", () => {
    it("carries them on the header, not on the `li` that wraps the children", () => {
      const directoryPath = path.join("/root", "src");
      const view = mount("directory", item("src", directoryPath));

      expect(view.header.dataset.name).toBe("src");
      expect(view.header.dataset.path).toBe(directoryPath);
      // On the `li` they would also match right-clicks on every nested entry,
      // since the walk visits ancestors.
      expect(view.element.dataset.name).toBeUndefined();
      expect(view.element.dataset.path).toBeUndefined();
      expect(view.name.dataset.name).toBeUndefined();
      expect(view.name.dataset.path).toBeUndefined();
    });

    it("uses the joined name for a squashed directory", () => {
      const directoryPath = path.join("/root", "a", "b");
      const view = mount("directory", item("a", directoryPath, { squashedNames: ["a/", "b"] }));

      expect(view.header.dataset.name).toBe("a/b");
      expect(view.header.dataset.path).toBe(directoryPath);
    });
  });

  describe("a special-root entry", () => {
    it("carries them on the `li`, as a regular file row does", () => {
      const filePath = path.join("/root", "notes.md");
      const view = mount("file", item("notes.md", filePath), {
        special: true,
        entryClassName: "recent-entry",
      });

      expect(view.element.dataset.name).toBe("notes.md");
      expect(view.element.dataset.path).toBe(filePath);
      expect(view.element.matches(".tree-view-special-entry.recent-entry")).toBe(true);
      // `is` names the kind, so a package matching `[is="tree-view-file"]`
      // reaches a pinned file the same way it reaches a project one.
      expect(view.element.getAttribute("is")).toBe("tree-view-file");
      expect(view.name.dataset.name).toBeUndefined();
      expect(view.name.dataset.path).toBeUndefined();
    });

    it("renders a special directory as an expandable directory row", () => {
      const view = mount("directory", item("notes", path.join("/root", "notes")), {
        special: true,
        entryClassName: "recent-entry",
      });

      expect(view.element.matches(".directory.list-nested-item")).toBe(true);
      expect(view.element.matches(".tree-view-special-entry.recent-entry")).toBe(true);
      expect(view.element.getAttribute("is")).toBe("tree-view-directory");
      expect(view.element.getAttribute("aria-expanded")).toBe("false");
    });

    it("puts the section class on a row inside an expanded pinned folder", () => {
      const view = mount("file", item("inner.js", path.join("/root", "notes", "inner.js")), {
        entryClassName: "recent-entry",
      });

      // Not pinned itself, so it is an ordinary entry that happens to render
      // inside the section — it renames and deletes like any other row.
      expect(view.element.matches(".recent-entry")).toBe(true);
      expect(view.element.matches(".tree-view-special-entry")).toBe(false);
    });
  });
});
