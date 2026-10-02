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

  it("uses a dedicated disclosure slot at depth zero", () => {
    const view = mount("directory", item("root", "/root"));

    expect(view.disclosure.classList.contains("tree-view-root-disclosure")).toBe(true);
    expect(view.disclosure.style.getPropertyValue("--tree-view-disclosure-depth")).toBe("0");
    expect(view.disclosure.nextElementSibling).toBe(view.header);
  });

  describe("synchronizing a mounted row", () => {
    it("leaves an unchanged row and its descendants untouched", () => {
      const view = mount("directory", item("src", "/root/src", { status: "modified" }), {
        depth: 2,
      });
      const observer = new MutationObserver(() => {});
      observer.observe(view.element, { attributes: true, childList: true, subtree: true });

      try {
        view.sync();
        view.entry.syncViews();

        expect(observer.takeRecords()).toEqual([]);
      } finally {
        observer.disconnect();
      }
    });

    it("updates each changed selection, status, depth and directory state", () => {
      const view = mount("directory", item("src", "/root/src", { status: "modified" }), {
        special: true,
      });
      const { entry, element } = view;

      treeView.selectedEntries.add(entry);
      entry.syncViews();
      expect(element.classList.contains("selected")).toBe(true);
      expect(element.getAttribute("aria-selected")).toBe("true");

      entry.item.status = "added";
      entry.syncViews();
      expect(element.classList.contains("status-modified")).toBe(false);
      expect(element.classList.contains("status-added")).toBe(true);

      entry.depth = 2;
      entry.syncViews();
      expect(view.indentGuides.childElementCount).toBe(2);
      expect(element.getAttribute("aria-level")).toBe("3");
      expect(view.disclosure.classList.contains("tree-view-root-disclosure")).toBe(false);
      expect(view.disclosure.style.getPropertyValue("--tree-view-disclosure-depth")).toBe("1");

      entry.isExpanded = true;
      entry.syncViews();
      expect(element.classList.contains("expanded")).toBe(true);
      expect(element.classList.contains("collapsed")).toBe(false);
      expect(element.isExpanded).toBe(true);
      expect(element.getAttribute("aria-expanded")).toBe("true");

      entry.item.ignoredByName = true;
      entry.syncViews();
      expect(element.classList.contains("ignored-name")).toBe(true);

      entry.exists = false;
      entry.syncViews();
      expect(element.classList.contains("status-removed")).toBe(true);

      entry.special = false;
      entry.syncViews();
      expect(element.classList.contains("status-removed")).toBe(false);
      entry.special = true;
      entry.syncViews();
      expect(element.classList.contains("status-removed")).toBe(true);

      treeView.selectedEntries.delete(entry);
      entry.item.status = null;
      entry.depth = 0;
      entry.isExpanded = false;
      entry.item.ignoredByName = false;
      entry.exists = true;
      entry.syncViews();
      expect(element.classList.contains("selected")).toBe(false);
      expect(element.getAttribute("aria-selected")).toBe("false");
      expect(element.classList.contains("status-added")).toBe(false);
      expect(view.indentGuides.childElementCount).toBe(0);
      expect(element.getAttribute("aria-level")).toBe("1");
      expect(element.classList.contains("expanded")).toBe(false);
      expect(element.classList.contains("collapsed")).toBe(true);
      expect(element.getAttribute("aria-expanded")).toBe("false");
      expect(element.classList.contains("ignored-name")).toBe(false);
      expect(element.classList.contains("status-removed")).toBe(false);
    });

    it("restores owned DOM state while preserving a consumer's other classes", () => {
      const view = mount("directory", item("src", "/root/src", { status: "modified" }), {
        depth: 2,
      });
      const { element } = view;
      element.classList.add("consumer-marker", "status-added", "selected");
      element.setAttribute("role", "button");
      element.setAttribute("aria-level", "99");
      element.setAttribute("aria-selected", "true");
      element.setAttribute("aria-expanded", "true");
      element.isExpanded = true;
      view.sync();
      expect(element.classList.contains("consumer-marker")).toBe(true);
      expect(element.classList.contains("status-modified")).toBe(true);
      expect(element.classList.contains("status-added")).toBe(false);
      expect(element.classList.contains("selected")).toBe(false);
      expect(element.getAttribute("role")).toBe("treeitem");
      expect(element.getAttribute("aria-level")).toBe("3");
      expect(element.getAttribute("aria-selected")).toBe("false");
      expect(element.getAttribute("aria-expanded")).toBe("false");
      expect(element.isExpanded).toBe(false);

      for (const [attribute, wrong, expected] of [
        ["role", "button", "treeitem"],
        ["aria-level", "99", "3"],
        ["aria-selected", "true", "false"],
        ["aria-expanded", "true", "false"],
      ]) {
        element.setAttribute(attribute, wrong);
        view.sync();
        expect(element.getAttribute(attribute)).toBe(expected);
      }
      element.isExpanded = true;
      view.sync();
      expect(element.isExpanded).toBe(false);

      view.indentGuides.replaceChildren();
      view.sync();
      expect(view.indentGuides.childElementCount).toBe(2);

      view.disclosure.classList.add("tree-view-root-disclosure");
      view.sync();
      expect(view.disclosure.classList.contains("tree-view-root-disclosure")).toBe(false);

      view.disclosure.style.setProperty("--tree-view-disclosure-depth", "99");
      view.sync();
      expect(view.disclosure.style.getPropertyValue("--tree-view-disclosure-depth")).toBe("1");
    });

    it("fully synchronizes a new entry with the same state when a view is rebound", () => {
      const view = mount("directory", item("src", "/root/src", { status: "modified" }), {
        depth: 2,
      });
      const previousEntry = view.entry;
      const entry = new TreeEntry(treeView, {
        kind: "directory",
        item: item("other", "/root/other", { status: "modified" }),
      });
      entry.depth = previousEntry.depth;
      entry.height = previousEntry.height;

      view.unbind();
      expect(view.syncState).toBeNull();
      view.bind(entry);

      expect(previousEntry.views.has(view)).toBe(false);
      expect(entry.views.has(view)).toBe(true);
      expect(view.header.dataset.path).toBe("/root/other");
      expect(view.element.classList.contains("collapsed")).toBe(true);
      expect(view.element.classList.contains("status-modified")).toBe(true);
      expect(view.element.getAttribute("aria-level")).toBe("3");
      expect(view.element.getAttribute("aria-expanded")).toBe("false");
      expect(view.indentGuides.childElementCount).toBe(2);
    });
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
