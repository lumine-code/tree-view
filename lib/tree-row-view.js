const { CompositeDisposable } = require("lumine");

module.exports = class TreeRowView {
  constructor(treeView, kind, { sticky = false } = {}) {
    this.treeView = treeView;
    this.kind = kind;
    this.sticky = sticky;
    this.entry = null;
    this.subscriptions = new CompositeDisposable();

    this.element = document.createElement("li");
    this.header = document.createElement("div");
    this.indentGuides = document.createElement("span");
    this.indentGuides.className = "tree-view-indent-guides";
    this.indentGuides.setAttribute("aria-hidden", "true");
    this.disclosure = null;
    if (kind === "directory") {
      this.disclosure = document.createElement("span");
      this.disclosure.className = "tree-view-disclosure";
      this.disclosure.setAttribute("aria-hidden", "true");
    }
    this.name = document.createElement("span");
  }

  bind(entry) {
    this.unbind();
    this.entry = entry;
    entry.views.add(this);

    const element = this.element;
    element.className = "";
    element.removeAttribute("data-name");
    element.removeAttribute("data-path");
    element.style.cssText = "";
    element.treeEntry = entry;
    element.header = null;
    element.directoryName = null;
    element.fileName = null;
    element.getPath = () => entry.getPath();
    element.isPathEqual = (pathToCompare) => entry.isPathEqual(pathToCompare);
    element.expand = (recursive) => entry.expand(recursive);
    element.collapse = (recursive) => entry.collapse(recursive);
    element.toggleExpansion = (recursive) => entry.toggleExpansion(recursive);
    element.reload = () => entry.reload();
    element.updateStatus = () => this.sync();
    element.directory = entry.directory;
    element.file = entry.file;

    if (this.sticky) {
      element.classList.add(
        "tree-view-sticky-header",
        "entry",
        "directory",
        "list-nested-item",
        "expanded",
      );
      element.style.setProperty("--tree-view-depth", entry.depth);
    } else {
      element.classList.add("tree-view-row", "entry");
      element.style.height = `${entry.height}px`;
      element.style.setProperty("--tree-view-depth", entry.depth);
    }

    if (this.kind === "directory") {
      this.bindDirectory(entry);
    } else {
      this.bindFile(entry);
    }

    if (entry.special) element.classList.add("tree-view-special-entry");
    if (entry.entryClassName) element.classList.add(entry.entryClassName);
    if (entry.specialRoot) {
      element.classList.add("tree-view-special-root");
      if (entry.rootClassName) element.classList.add(entry.rootClassName);
    }

    this.sync();
    return element;
  }

  bindDirectory(entry) {
    const { element, header, indentGuides, disclosure, name } = this;
    header.replaceChildren(name);
    element.replaceChildren(indentGuides, disclosure, header);
    element.classList.add("directory", "list-nested-item");
    if (!this.sticky) element.setAttribute("is", "tree-view-directory");
    header.className = this.sticky
      ? "tree-view-sticky-header-row header list-item"
      : "header list-item";
    name.className = "";
    name.replaceChildren();

    const displayName =
      entry.directory?.squashedNames != null ? entry.directory.squashedNames.join("") : entry.name;
    name.title = displayName;
    header.dataset.name = displayName;
    header.dataset.path = entry.getPath();

    if (entry.directory?.squashedNames != null) {
      const squashedName = document.createElement("span");
      squashedName.classList.add("squashed-dir");
      squashedName.textContent = entry.directory.squashedNames[0];
      name.appendChild(squashedName);
      name.appendChild(document.createTextNode(entry.directory.squashedNames[1]));
    } else {
      name.textContent = displayName;
    }

    if (entry.projectRoot || entry.specialRoot) {
      element.classList.add("project-root");
      header.classList.add("project-root-header");
    }

    if (entry.specialRoot) {
      name.classList.add("name", "icon");
      if (entry.iconClass) name.classList.add(entry.iconClass);
    } else {
      this.refreshIcon();
    }

    element.header = header;
    element.directoryName = name;
    element.draggable = !entry.projectRoot && !entry.specialRoot;
    header.draggable = entry.projectRoot && !this.sticky;
  }

  bindFile(entry) {
    const { element, indentGuides, name } = this;
    element.replaceChildren(indentGuides, name);
    element.classList.add("file", "list-item");
    element.setAttribute("is", "tree-view-file");
    element.dataset.name = entry.name;
    element.dataset.path = entry.getPath();
    element.draggable = true;

    name.className = "";
    name.textContent = entry.name;
    name.title = entry.getPath();
    this.refreshIcon();

    element.fileName = name;
  }

  // Core enriches missing filesystem and repository hints for every path
  // consumer. Tree-view passes facts its entry model already paid to learn,
  // avoiding duplicate filesystem work while core still owns icon selection.
  refreshIcon() {
    const { entry, name } = this;
    if (!entry || entry.specialRoot) return;

    let hints;
    if (this.kind === "directory") {
      hints = {
        directory: true,
        symlink: entry.directory?.symlink,
      };
    } else {
      hints = { directory: false, symlink: entry.file?.symlink };
    }

    this.iconDisposable = lumine.icons.applyTo(
      name,
      { path: entry.getPath(), context: "tree-view", hints },
      { classes: ["name"], setData: false },
    );
  }

  syncIndentGuides() {
    const { indentGuides, disclosure } = this;
    const depth = this.entry?.depth ?? 0;
    while (indentGuides.childElementCount > depth) {
      indentGuides.lastElementChild.remove();
    }
    while (indentGuides.childElementCount < depth) {
      const guide = document.createElement("span");
      guide.className = "tree-view-indent-guide";
      indentGuides.appendChild(guide);
    }

    if (disclosure) {
      disclosure.classList.toggle("tree-view-root-disclosure", depth === 0);
      disclosure.style.setProperty("--tree-view-disclosure-depth", Math.max(depth - 1, 0));
    }
  }

  sync() {
    const { entry, element } = this;
    if (!entry) return;

    const expandable = this.kind === "directory";
    const selected = this.treeView.selectedEntries.has(entry);
    const ignored = entry.item?.ignoredByName === true;
    const removed = Boolean(entry.special && !entry.exists);
    const status = entry.item?.status;
    const state = this.syncState;
    // A directory expansion revisits every mounted row, and scrolling revisits
    // the sticky rows. Rewriting unchanged attributes and removing/re-adding
    // the same status class makes those rows require another style pass. Keep
    // their last synchronized state, but also notice DOM edits from consumers
    // so updateStatus still restores the attributes and status classes it owns.
    if (
      state &&
      state.entry === entry &&
      state.kind === this.kind &&
      state.depth === entry.depth &&
      state.expanded === entry.isExpanded &&
      state.selected === selected &&
      state.ignored === ignored &&
      state.removed === removed &&
      state.status === status &&
      state.className === element.className &&
      element.isExpanded === entry.isExpanded &&
      this.indentGuides.childElementCount === entry.depth &&
      element.getAttribute("role") === "treeitem" &&
      element.getAttribute("aria-level") === state.ariaLevel &&
      element.getAttribute("aria-selected") === state.ariaSelected &&
      element.getAttribute("aria-expanded") === state.ariaExpanded &&
      (!this.disclosure ||
        (this.disclosure.className === state.disclosureClassName &&
          this.disclosure.style.cssText === state.disclosureStyle))
    ) {
      return;
    }

    this.syncIndentGuides();
    element.classList.toggle("expanded", expandable && entry.isExpanded);
    element.classList.toggle("collapsed", expandable && !entry.isExpanded);
    element.classList.toggle("selected", selected);
    element.classList.toggle("ignored-name", ignored);
    element.classList.toggle("status-removed", removed);
    element.isExpanded = entry.isExpanded;
    element.setAttribute("role", "treeitem");
    element.setAttribute("aria-level", entry.depth + 1);
    element.setAttribute("aria-selected", selected ? "true" : "false");
    if (expandable) {
      element.setAttribute("aria-expanded", entry.isExpanded ? "true" : "false");
    } else {
      element.removeAttribute("aria-expanded");
    }

    for (const className of Array.from(element.classList)) {
      if (className.startsWith("status-") && className !== "status-removed") {
        element.classList.remove(className);
      }
    }
    if (status != null) {
      element.classList.add(`status-${status}`);
    }

    this.syncState = {
      entry,
      kind: this.kind,
      depth: entry.depth,
      expanded: entry.isExpanded,
      selected,
      ignored,
      removed,
      status,
      className: element.className,
      ariaLevel: element.getAttribute("aria-level"),
      ariaSelected: element.getAttribute("aria-selected"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      disclosureClassName: this.disclosure?.className,
      disclosureStyle: this.disclosure?.style.cssText,
    };
  }

  unbind() {
    this.syncState = null;
    if (this.entry) {
      this.entry.views.delete(this);
      this.entry = null;
    }
    this.iconDisposable?.dispose();
    this.iconDisposable = null;
    this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();
    this.element.treeEntry = null;
  }

  destroy() {
    this.unbind();
    this.element.remove();
  }
};
