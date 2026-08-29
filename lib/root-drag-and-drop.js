const { isAbsolute } = require("path");
const { pathToFileURL } = require("url");

module.exports = class RootDragAndDropHandler {
  constructor(treeView) {
    this.onDragStart = this.onDragStart.bind(this);
    this.onDragEnter = this.onDragEnter.bind(this);
    this.onDragLeave = this.onDragLeave.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);
    this.onDragOver = this.onDragOver.bind(this);
    this.onDrop = this.onDrop.bind(this);
    this.onDropEvent = (event) => {
      void this.onDrop(event).catch((error) => console.error(error));
    };
    this.treeView = treeView;
    this.sessionTokens = new Set();
    this.handleEvents();
  }

  dispose() {
    this.cancelPendingLeave();
    this.treeView.element.removeEventListener("dragenter", this.onDragEnter);
    this.treeView.element.removeEventListener("dragend", this.onDragEnd);
    this.treeView.element.removeEventListener("dragleave", this.onDragLeave);
    this.treeView.element.removeEventListener("dragover", this.onDragOver);
    this.treeView.element.removeEventListener("drop", this.onDropEvent);
    for (const token of Array.from(this.sessionTokens)) {
      void Promise.resolve(
        lumine.workspaceDrops.rollback(token, "tree view destroyed during project-root drag"),
      ).catch(() => {});
    }
    this.sessionTokens.clear();
  }

  handleEvents() {
    // onDragStart is called directly by TreeView's onDragStart
    this.treeView.element.addEventListener("dragenter", this.onDragEnter);
    this.treeView.element.addEventListener("dragend", this.onDragEnd);
    this.treeView.element.addEventListener("dragleave", this.onDragLeave);
    this.treeView.element.addEventListener("dragover", this.onDragOver);
    this.treeView.element.addEventListener("drop", this.onDropEvent);
  }

  onDragStart(e) {
    if (!this.treeView.list.contains(e.target)) {
      return;
    }

    this.prevDropTargetIndex = null;
    const projectRoot = this.treeView.treeEntryForElement(e.target);
    if (!projectRoot?.projectRoot) return;
    const { directory } = projectRoot;

    // Collect all selected project roots if the dragged root is among them
    const selectedRoots = this.treeView.getSelectedEntries().filter((entry) => entry.projectRoot);
    const fromRootPaths =
      selectedRoots.length > 0 && selectedRoots.some((r) => r.directory === directory)
        ? selectedRoots.map((r) => r.directory.path)
        : [directory.path];
    const paths = [...new Set(fromRootPaths)];
    const token = this.createSession(paths);

    e.dataTransfer.effectAllowed = "move";
    lumine.workspaceDrops.write(e.dataTransfer, {
      kind: "project-roots",
      token,
      effect: "move",
      allowedLocations: ["center"],
      source: { windowId: this.getWindowId() },
      items: paths.map((path) => ({ type: "directory", path })),
    });
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    e.dataTransfer.setData(
      "text/uri-list",
      paths.map((path) => this.uriForPath(path)).join("\r\n"),
    );
  }

  uriForPath(path) {
    return !isAbsolute(path) && URL.canParse(path) ? path : pathToFileURL(path).href;
  }

  createSession(paths) {
    const { token } = lumine.workspaceDrops.createSession(
      { paths: paths.slice() },
      {
        commit: (_result, session) => {
          this.sessionTokens.delete(token);
          const transferredPaths = new Set(session.paths);
          const projectPaths = lumine.project.getPaths();
          const remainingPaths = projectPaths.filter((path) => !transferredPaths.has(path));
          if (remainingPaths.length !== projectPaths.length) {
            return lumine.project.setPaths(remainingPaths);
          }
        },
        rollback: () => this.sessionTokens.delete(token),
      },
    );
    this.sessionTokens.add(token);
    return token;
  }

  onDragEnter(e) {
    if (!this.treeView.list.contains(e.target)) {
      return;
    }
    if (!this.isLumineTreeViewEvent(e)) {
      return;
    }

    this.cancelPendingLeave();
    return e.stopPropagation();
  }

  onDragLeave(e) {
    if (!this.isLumineTreeViewEvent(e)) {
      return;
    }

    e.stopPropagation();
    if (this.treeView.element.contains(e.relatedTarget)) return;
    this.cancelPendingLeave();
    this.leaveFrame = requestAnimationFrame(() => {
      this.leaveFrame = null;
      this.clearDropTarget();
    });
  }

  onDragEnd(e) {
    if (!e.target.matches(".project-root-header")) {
      return;
    }
    if (!this.isLumineTreeViewEvent(e)) {
      return;
    }

    this.cancelPendingLeave();
    e.stopPropagation();
    return this.clearDropTarget();
  }

  onDragOver(e) {
    let element;
    if (!this.treeView.list.contains(e.target)) {
      return;
    }
    if (!this.isLumineTreeViewEvent(e)) {
      return;
    }

    this.cancelPendingLeave();
    e.preventDefault();
    e.stopPropagation();

    if (this.treeView.roots.length === 0) {
      this.treeView.list.appendChild(this.getPlaceholder());
      return;
    }

    const newDropTargetIndex = this.getDropTargetIndex(e);
    if (newDropTargetIndex == null) {
      return;
    }
    if (this.prevDropTargetIndex === newDropTargetIndex) {
      return;
    }
    this.prevDropTargetIndex = newDropTargetIndex;

    const projectRoots = this.treeView.roots;

    const placeholder = this.getPlaceholder();
    if (newDropTargetIndex < projectRoots.length) {
      const root = projectRoots[newDropTargetIndex];
      element = this.treeView.elementForTreeEntry(root);
      element?.classList.add("is-drop-target");
      placeholder.style.top = `${root.top}px`;
    } else {
      const root = projectRoots[newDropTargetIndex - 1];
      element = this.treeView.elementForTreeEntry(root);
      element?.classList.add("drop-target-is-after");
      placeholder.style.top = `${this.treeView.rowTops[root.subtreeEndIndex]}px`;
    }
    this.treeView.list.appendChild(placeholder);
    return placeholder;
  }

  clearDropTarget() {
    const element = this.treeView.element.querySelector(".is-dragging");
    element?.classList.remove("is-dragging");
    element?.updateTooltip();
    for (const target of this.treeView.element.querySelectorAll(
      ".is-drop-target, .drop-target-is-after",
    )) {
      target.classList.remove("is-drop-target", "drop-target-is-after");
    }
    return this.removePlaceholder();
  }

  cancelPendingLeave() {
    if (this.leaveFrame != null) cancelAnimationFrame(this.leaveFrame);
    this.leaveFrame = null;
  }

  async onDrop(e) {
    if (!this.treeView.list.contains(e.target)) {
      return;
    }
    if (!this.isLumineTreeViewEvent(e)) {
      return;
    }

    this.cancelPendingLeave();
    e.preventDefault();
    e.stopPropagation();

    const { dataTransfer } = e;
    const descriptor = this.readDescriptor(dataTransfer);
    if (!descriptor) return this.clearDropTarget();
    const fromWindowId = descriptor.source.windowId;
    const fromRootPaths = descriptor.items.map((item) => item.path);

    let toIndex = this.getDropTargetIndex(e) ?? this.prevDropTargetIndex;
    if (!Number.isInteger(toIndex)) return this.clearDropTarget();

    this.clearDropTarget();

    let previousProjectPaths = null;
    try {
      if (fromWindowId === this.getWindowId()) {
        const projectPaths = lumine.project.getPaths();

        // Find current indices of all selected roots, sorted ascending
        const fromIndices = fromRootPaths
          .map((path) => projectPaths.indexOf(path))
          .filter((index) => index !== -1)
          .sort((a, b) => a - b);

        if (fromIndices.length > 0) {
          // Adjust toIndex by how many selected roots sit before the drop target
          const adjustedToIndex = toIndex - fromIndices.filter((index) => index < toIndex).length;

          // Build the new order: remove selected roots, then insert them at adjusted position
          const extracted = fromIndices.map((index) => projectPaths[index]);
          const selectedIndices = new Set(fromIndices);
          const remaining = projectPaths.filter((_, index) => !selectedIndices.has(index));
          remaining.splice(adjustedToIndex, 0, ...extracted);

          if (remaining.join("\0") !== projectPaths.join("\0")) {
            await Promise.resolve(lumine.project.setPaths(remaining));
          }
        }

        await lumine.workspaceDrops.rollback(
          descriptor.token,
          "project roots reordered within their source window",
        );
      } else {
        const projectPaths = lumine.project.getPaths();
        previousProjectPaths = projectPaths.slice();
        const transferredPaths = new Set(fromRootPaths);
        const removedBeforeTarget = projectPaths
          .slice(0, toIndex)
          .filter((path) => transferredPaths.has(path)).length;
        const remainingPaths = projectPaths.filter((path) => !transferredPaths.has(path));
        toIndex = Math.max(0, Math.min(toIndex - removedBeforeTarget, remainingPaths.length));
        remainingPaths.splice(toIndex, 0, ...fromRootPaths);
        await Promise.resolve(lumine.project.setPaths(remainingPaths));
        const updatedProjectPaths = lumine.project.getPaths();
        if (fromRootPaths.some((path) => !updatedProjectPaths.includes(path))) {
          throw new Error("The target window could not add every dragged project root");
        }
        const committed = await lumine.workspaceDrops.commit(descriptor.token, {
          sourceWindowId: fromWindowId,
        });
        if (committed === false) {
          throw new Error("The source window rejected the project-root transfer");
        }
      }
    } catch (error) {
      if (previousProjectPaths) {
        try {
          await Promise.resolve(lumine.project.setPaths(previousProjectPaths));
        } catch {
          // Keep the original transfer failure.
        }
      }
      try {
        await lumine.workspaceDrops.rollback(descriptor.token, error.message);
      } catch {
        // Keep the original project update failure.
      }
      throw error;
    }
  }

  readDescriptor(dataTransfer) {
    const descriptor = lumine.workspaceDrops.read(dataTransfer);
    if (descriptor?.kind !== "project-roots") return null;
    if (typeof descriptor.token !== "string" || descriptor.token.length === 0) return null;
    if (!Number.isInteger(descriptor.source?.windowId)) return null;
    if (!Array.isArray(descriptor.items) || descriptor.items.length === 0) return null;
    if (
      descriptor.items.some(
        (item) =>
          item?.type !== "directory" || typeof item.path !== "string" || item.path.length === 0,
      )
    ) {
      return null;
    }
    if (new Set(descriptor.items.map((item) => item.path)).size !== descriptor.items.length) {
      return null;
    }
    return descriptor;
  }

  getDropTargetIndex(e) {
    if (this.isPlaceholder(e.target)) {
      return;
    }

    const projectRoots = this.treeView.roots;
    let projectRoot = this.treeView.treeEntryForElement(e.target);
    while (projectRoot?.parent) projectRoot = projectRoot.parent;
    if (!projectRoot?.projectRoot) projectRoot = null;
    if (!projectRoot) {
      projectRoot = projectRoots[projectRoots.length - 1];
    }

    if (!projectRoot) {
      return 0;
    }

    const projectRootIndex = this.treeView.roots.indexOf(projectRoot);

    const projectRootElement = this.treeView.elementForTreeEntry(projectRoot);
    if (!projectRootElement) return projectRootIndex;
    const rect = projectRootElement.getBoundingClientRect();
    const center = rect.top + rect.height / 2;

    if (e.pageY < center) {
      return projectRootIndex;
    } else {
      return projectRootIndex + 1;
    }
  }

  canDragStart(e) {
    return (
      Boolean(e.target.closest(".project-root-header")) &&
      this.treeView.treeEntryForElement(e.target)?.projectRoot
    );
  }

  isDragging(e) {
    return this.isLumineTreeViewEvent(e);
  }

  isLumineTreeViewEvent(e) {
    return lumine.workspaceDrops.inspect(e.dataTransfer)?.kind === "project-roots";
  }

  getPlaceholder() {
    if (!this.placeholderEl) {
      this.placeholderEl = document.createElement("li");
      this.placeholderEl.classList.add("placeholder");
      this.placeholderEl.style.position = "absolute";
    }
    return this.placeholderEl;
  }

  removePlaceholder() {
    this.placeholderEl?.remove();
    return (this.placeholderEl = null);
  }

  isPlaceholder(element) {
    return element.classList.contains("placeholder");
  }

  getWindowId() {
    return this.windowId != null ? this.windowId : (this.windowId = lumine.window.getId());
  }
};
