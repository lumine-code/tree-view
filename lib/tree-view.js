const path = require("path");
const os = require("os");
const { pathToFileURL } = require("url");
const { webUtils } = require("electron");
const fs = require("./fs-compat");
const { CompositeDisposable, Emitter } = require("lumine");

const { repoForPath, getStyleObject, getDuplicateCopyPath } = require("./helpers");

const AddDialog = require("./add-dialog");
const MoveDialog = require("./move-dialog");
const CopyDialog = require("./copy-dialog");
const FileOperationProcess = require("./file-operation-process");

let IgnoredNames; // Defer requiring until actually needed

const AddProjectsView = require("./add-projects-view");
const Directory = require("./directory");
const RootDragAndDrop = require("./root-drag-and-drop");
const TreeEntry = require("./tree-entry");
const TreeRowView = require("./tree-row-view");
const TreeRootSection = require("./tree-root-section");
const repositoryStatusObserver = require("./repository-status-observer");

const TREE_VIEW_URI = "lumine://tree-view";
const TREE_VIEW_CLIPBOARD_FORMAT = "application/lumine-tree-view";
const TREE_VIEW_CLIPBOARD_VERSION = 1;
const OPERATION_STATUS_DELAY = 250;
const DELETE_CONFIRMATION_PATH_LIMIT = 5;

function toggleConfig(keyPath) {
  return lumine.config.set(keyPath, !lumine.config.get(keyPath));
}

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  const digits = value >= 10 || unit === "B" ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

function getOperationKind(operation) {
  switch (operation) {
    case "copy":
      return { icon: "icon-clippy", label: "Copy" };
    case "move":
      return { icon: "icon-diff-renamed", label: "Move" };
    default:
      return { icon: "icon-file", label: "File operation" };
  }
}

function createOperationCommandButton({ className, icon, title, command }) {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("btn", "btn-xs", "icon", icon, "tree-view-operation-button", className);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const commandName = typeof command === "function" ? command() : command;
    if (commandName) lumine.commands.dispatch(lumine.workspace.getElement(), commandName);
  });
  return button;
}

let nextId = 1;

class TreeView {
  constructor(state) {
    this.onDragLeave = this.onDragLeave.bind(this);
    this.onDragEnter = this.onDragEnter.bind(this);

    this.id = nextId++;

    this.element = document.createElement("div");
    this.element.classList.add("tool-panel", "tree-view");
    this.element.tabIndex = -1;

    this.viewport = document.createElement("div");
    this.viewport.classList.add("tree-view-viewport");

    this.scroller = document.createElement("div");
    this.scroller.classList.add("tree-view-scroller");

    this.list = document.createElement("ol");
    this.list.classList.add("tree-view-root", "full-menu", "list-tree", "focusable-panel");
    this.list.setAttribute("role", "tree");

    // Keep the two row shapes the model needs in their own, non-rendering
    // list. A ResizeObserver can then report theme-driven height changes after
    // the browser's layout pass instead of a stylesheet event forcing layout
    // for every mounted row.
    this.rowMetrics = document.createElement("ol");
    this.rowMetrics.classList.add("tree-view-row-metrics", "list-tree");
    this.rowMetrics.setAttribute("aria-hidden", "true");

    this.regularRowMetricsProbe = document.createElement("li");
    this.regularRowMetricsProbe.classList.add(
      "tree-view-metrics-probe",
      "file",
      "entry",
      "list-item",
    );
    this.regularRowMetricsProbe.textContent = "M";

    this.rootRowMetricsProbe = document.createElement("li");
    this.rootRowMetricsProbe.classList.add(
      "tree-view-metrics-probe",
      "directory",
      "entry",
      "list-nested-item",
      "project-root",
      "expanded",
    );
    this.rootHeaderMetricsProbe = document.createElement("div");
    this.rootHeaderMetricsProbe.classList.add("header", "list-item", "project-root-header");
    this.rootHeaderMetricsProbe.textContent = "M";
    this.rootRowMetricsProbe.appendChild(this.rootHeaderMetricsProbe);
    this.rowMetrics.append(this.regularRowMetricsProbe, this.rootRowMetricsProbe);

    this.stickyHeaderLayer = document.createElement("div");
    this.stickyHeaderLayer.classList.add("tree-view-sticky-header-layer");
    this.stickyHeaderLayer.setAttribute("aria-hidden", "true");
    this.stickyHeaderLayer.hidden = true;

    this.stickyHeaderList = document.createElement("ol");
    this.stickyHeaderList.classList.add("tree-view-sticky-header-list", "full-menu", "list-tree");
    this.stickyHeaderLayer.appendChild(this.stickyHeaderList);
    this.scroller.appendChild(this.list);
    this.viewport.append(this.scroller, this.stickyHeaderLayer);
    this.element.append(this.viewport, this.rowMetrics);

    this.operationStatus = document.createElement("div");
    this.operationStatus.classList.add("tree-view-operation-status");
    this.operationStatus.hidden = true;

    this.operationStatusHeader = document.createElement("div");
    this.operationStatusHeader.classList.add("tree-view-operation-header");
    this.operationProgressLabel = document.createElement("span");
    this.operationProgressLabel.classList.add("tree-view-operation-progress-label");
    this.operationProgress = document.createElement("progress");
    this.operationProgress.classList.add("tree-view-operation-progress");
    this.operationProgress.max = 1;
    this.operationProgress.value = 0;
    this.operationPauseButton = createOperationCommandButton({
      className: "tree-view-operation-pause",
      icon: "icon-playback-pause",
      title: "Pause queue after the current operation",
      command: () =>
        this.fileOperationProcess?.isQueuePaused()
          ? "tree-view:resume-queue"
          : "tree-view:pause-queue",
    });
    this.operationClearButton = createOperationCommandButton({
      className: "tree-view-operation-clear",
      icon: "icon-trashcan",
      title: "Clear queued operations",
      command: "tree-view:clear-queue",
    });
    this.operationStatusHeader.append(
      this.operationProgressLabel,
      this.operationProgress,
      this.operationPauseButton,
      this.operationClearButton,
    );

    this.operationList = document.createElement("div");
    this.operationList.classList.add("tree-view-operation-list");
    this.operationStatus.append(this.operationStatusHeader, this.operationList);
    this.element.appendChild(this.operationStatus);

    this.stickyHeaderMode = "none";
    this.stickyHeaderEntries = [];
    this.stickyHeaderUpdateFrame = null;

    this.treeEntries = new Set();
    this.projectEntries = new Set();
    this.visibleRows = [];
    this.rowTops = [0];
    this.rowViews = new Map();
    this.selectedEntries = new Set();
    this.regularRowHeight = 24;
    this.rootRowHeight = 32;
    this.contentWidth = 0;
    this.scrollportWidth = 0;
    this.scrollportHeight = 0;
    this.viewportMetricsFresh = false;
    this.stickyHeaderClipPath = null;
    // The scroll position every internal reader consults instead of the
    // element: reading scrollTop back forces layout whenever the tree has
    // pending writes, and rebuilds must stay pure writes. The scroll listener
    // and setScrollTop/setScrollLeft keep it current.
    this.scrollPosition = { top: 0, left: 0 };

    this.disposables = new CompositeDisposable();
    this.disposables.add(
      lumine.workspaceDrops.addTarget(
        this.element,
        { surface: "tree-view", canDrop: () => false },
        { priority: 1000 },
      ),
    );
    this.emitter = new Emitter();
    this.fileOperationProcess = new FileOperationProcess({
      onDidStart: (operation) => this.beginOperationStatus(operation),
      onDidProgress: (progress) => this.updateOperationStatus(progress),
      onDidFinish: () => this.finishOperationStatus(),
      onDidChange: (operations) => this.fileOperationQueueChanged(operations),
      onConflict: (conflict) => this.resolveFileOperationConflict(conflict),
    });
    this.disposables.add(
      lumine.config.observe("tree-view.treeAppearance", (appearance) => {
        this.setTreeAppearance(appearance);
      }),
      lumine.config.observe("tree-view.stickyHeaders", (mode) => {
        this.setStickyHeaderMode(mode);
      }),
    );

    if (typeof ResizeObserver === "function") {
      this.rowMetricsResizeObserver = new ResizeObserver(() => {
        if (this.measureRowHeights()) this.rebuildVisibleRows();
      });
      this.rowMetricsResizeObserver.observe(this.regularRowMetricsProbe, { box: "border-box" });
      this.rowMetricsResizeObserver.observe(this.rootHeaderMetricsProbe, { box: "border-box" });

      // Content and scrollport metrics arrive here, after the engine's own
      // layout pass, where reading them is free. Rebuilds consume the cached
      // values and never measure on their own — see renderVisibleRows.
      this.metricsResizeObserver = new ResizeObserver(() => this.refreshViewportMetrics());
      this.metricsResizeObserver.observe(this.list);
      this.metricsResizeObserver.observe(this.scroller);
    }

    this.roots = [];
    this.rootsUpdateGeneration = 0;

    this.selectOnMouseUp = null;
    this.lastFocusedEntry = null;
    this.ignoredPatterns = [];
    this.useSyncFS = false;
    this.currentlyOpening = new Map();

    this.openExternalService = null;

    this.editorsToMove = new Map();

    this.dragEventCounts = new WeakMap();
    this.rootDragAndDrop = new RootDragAndDrop(this);

    this.specialRoots = [];

    this.handleEvents();

    const serializedSelection = state.selectedPaths?.length > 0 ? state.selectedPaths : null;
    this.updateRoots(
      state.directoryExpansionStates,
      serializedSelection
        ? {
            selectedPaths: serializedSelection,
            focusedPath: serializedSelection.at(-1),
          }
        : null,
    );

    if (!serializedSelection) {
      this.selectEntry(this.roots[0]);
    }

    if (state.scrollTop != null || state.scrollLeft != null) {
      // We have to restore the last scroll offsets, but it's too early. We use
      // an `IntersectionObserver` so that we can be notified when the element
      // is rendered and visible. At that point, we can make the changes
      // exactly once, then disconnect this observer.
      let observer = new IntersectionObserver(() => {
        if (this.isVisible()) {
          this.setScrollTop(state.scrollTop ?? 0);
          this.setScrollLeft(state.scrollLeft ?? 0);
          this.updateStickyHeaderOverlay();
          observer.disconnect();
        }
      });
      observer.observe(this.element);
    }

    if (state.width > 0) {
      this.element.style.width = `${state.width}px`;
    }

    this.disposables.add(
      this.onWillMoveEntry(({ initialPath }) => {
        let isDir = fs.isDirectorySync(initialPath);
        if (isDir) initialPath += path.sep;
        const editorPaths = new Set();
        for (let editor of lumine.workspace.getTextEditors()) {
          let filePath = editor.getPath();
          if (isDir ? filePath?.startsWith(initialPath) : filePath === initialPath) {
            editorPaths.add(filePath);
          }
        }
        this.editorsToMove.set(initialPath, editorPaths);
      }),
      this.onEntryMoved(({ initialPath, newPath }) => {
        const moveKey = fs.isDirectorySync(newPath) ? initialPath + path.sep : initialPath;
        const editorPaths = this.editorsToMove.get(moveKey);
        if (editorPaths) {
          for (let editor of lumine.workspace.getTextEditors()) {
            let filePath = editor.getPath();
            if (editorPaths.has(filePath)) {
              editor.getBuffer().setPath(filePath.replace(initialPath, newPath));
            }
          }
          this.editorsToMove.delete(moveKey);
        }
        this.refreshSpecialRoots();
      }),
      this.onMoveEntryFailed(({ initialPath }) => {
        this.editorsToMove.delete(initialPath);
        this.editorsToMove.delete(initialPath + path.sep);
      }),
      this.onEntryDeleted(() => {
        this.refreshSpecialRoots();
      }),
    );
  }

  serialize() {
    let { left: scrollLeft, top: scrollTop } = this.scrollPosition;
    let width = parseInt(this.element.style.width || 0, 10);

    class ExpansionStateBuilder {
      constructor(roots) {
        for (let root of roots) {
          this[root.directory.path] = root.directory.serializeExpansionState();
        }
      }
    }

    return {
      directoryExpansionStates: new ExpansionStateBuilder(this.roots),
      deserializer: "TreeView",
      selectedPaths: Array.from(this.getSelectedEntries(), (item) => item.getPath()),
      scrollLeft,
      scrollTop,
      width,
    };
  }

  destroy() {
    const operationsDestroyed = this.fileOperationProcess.destroy();
    this.clearOperationStatus();
    if (this.stickyHeaderUpdateFrame != null) {
      cancelAnimationFrame(this.stickyHeaderUpdateFrame);
      this.stickyHeaderUpdateFrame = null;
    }
    this.destroyRowViews();
    this.clearStickyHeaderViews();
    this.rowMetricsResizeObserver?.disconnect();
    this.metricsResizeObserver?.disconnect();
    for (let root of this.roots) {
      root.directory.destroy();
      this.unregisterTreeEntry(root);
    }
    for (const section of this.specialRoots) {
      section.destroy();
    }
    this.specialRoots = [];
    this.disposables.dispose();
    this.rootDragAndDrop.dispose();
    this.emitter.emit("did-destroy");
    return operationsDestroyed;
  }

  setBusySignal(busySignal) {
    this.operationBusyProvider?.dispose();
    this.operationBusyProvider = null;
    this.busySignal = busySignal;
    if (this.currentFileOperation) this.showBusyOperationStatus();
  }

  beginOperationStatus(operation) {
    this.currentFileOperation = {
      ...operation,
      phase: operation.operation === "copy" ? "copying" : "moving",
      startedAt: Date.now(),
    };
    this.showBusyOperationStatus();
    // One delay covers the whole uninterrupted queue lifetime. A sequence of
    // short jobs should neither flash the panel by briefly having two entries
    // nor keep postponing it each time the worker advances to the next one.
    if (this.operationStatus.hidden && this.operationStatusDelay == null) {
      this.operationStatusDelay = setTimeout(() => {
        this.operationStatusDelay = null;
        if (this.fileOperationProcess.getOperations().length === 0) return;
        this.showOperationStatus();
      }, OPERATION_STATUS_DELAY);
    }
  }

  updateOperationStatus(progress) {
    if (!this.currentFileOperation || progress.id !== this.currentFileOperation.id) return;
    const previousTitle = this.getBusyOperationTitle();
    Object.assign(this.currentFileOperation, progress);
    const nextTitle = this.getBusyOperationTitle();
    if (this.operationBusyProvider && previousTitle !== nextTitle) {
      this.operationBusyProvider.changeTitle(nextTitle, previousTitle);
    }
    if (!this.operationStatus.hidden) this.renderCurrentOperationStatus();
  }

  finishOperationStatus() {
    this.operationBusyProvider?.dispose();
    this.operationBusyProvider = null;
    this.currentFileOperation = null;
    if (this.fileOperationProcess.getOperations().length === 0) this.clearOperationStatus();
  }

  fileOperationQueueChanged(operations) {
    if (operations.length === 0) {
      this.clearOperationStatus();
    } else if (!this.operationStatus.hidden) {
      this.renderOperationStatus();
    }
  }

  pauseOperationQueue() {
    return this.fileOperationProcess.pauseQueue();
  }

  resumeOperationQueue() {
    return this.fileOperationProcess.resumeQueue();
  }

  clearOperationQueue() {
    return this.fileOperationProcess.clearQueue();
  }

  showOperationStatus() {
    clearTimeout(this.operationStatusDelay);
    this.operationStatusDelay = null;
    this.operationStatus.hidden = false;
    this.renderOperationStatus();
    if (!this.operationStatusInterval) {
      this.operationStatusInterval = setInterval(() => this.renderCurrentOperationStatus(), 1000);
    }
  }

  clearOperationStatus() {
    clearTimeout(this.operationStatusDelay);
    clearInterval(this.operationStatusInterval);
    this.operationStatusDelay = null;
    this.operationStatusInterval = null;
    this.operationStatus.hidden = true;
    this.operationList.replaceChildren();
    this.operationBusyProvider?.dispose();
    this.operationBusyProvider = null;
  }

  showBusyOperationStatus() {
    if (!this.busySignal || !this.currentFileOperation) return;
    this.operationBusyProvider = this.busySignal.create();
    this.operationBusyProvider.add(this.getBusyOperationTitle());
  }

  getOperationAction(operation = this.currentFileOperation) {
    switch (operation?.phase) {
      case "copying":
        return "Copying";
      case "copying-to-move":
        return "Copying to move";
      case "cancelling":
        return "Cancelling";
      default:
        return operation?.operation === "copy" ? "Copying" : "Moving";
    }
  }

  getBusyOperationTitle() {
    const name = path.basename(this.currentFileOperation.sourcePath);
    return `tree-view: ${this.getOperationAction()} ${name}`;
  }

  renderOperationHeader(operations) {
    const { completed, total } = this.fileOperationProcess.getQueueProgress();
    const hasQueuedOperations = operations.some((operation) => operation.state === "queued");
    const queuePaused = this.fileOperationProcess.isQueuePaused();
    const progressText = `${completed} / ${total}`;
    const progressTitle = `${completed} of ${total} file operations finished`;

    this.operationProgressLabel.textContent = progressText;
    this.operationProgressLabel.title = progressTitle;
    this.operationProgress.max = Math.max(total, 1);
    this.operationProgress.value = Math.min(completed, total);
    this.operationProgress.setAttribute("aria-label", progressTitle);

    this.operationStatusHeader.classList.toggle("is-paused", queuePaused);
    this.operationPauseButton.classList.toggle("icon-playback-pause", !queuePaused);
    this.operationPauseButton.classList.toggle("icon-playback-play", queuePaused);
    this.operationPauseButton.title = queuePaused
      ? "Resume queue"
      : "Pause queue after the current operation";
    this.operationPauseButton.setAttribute("aria-label", this.operationPauseButton.title);
    this.operationPauseButton.disabled = !hasQueuedOperations;
    this.operationClearButton.disabled = !hasQueuedOperations;
  }

  renderOperationStatus() {
    const operations = this.fileOperationProcess.getOperations();
    this.renderOperationHeader(operations);
    this.operationList.replaceChildren();
    for (const originalOperation of operations) {
      let operation = originalOperation;
      if (operation.id === this.currentFileOperation?.id) {
        operation = { ...operation, ...this.currentFileOperation };
      }

      const row = document.createElement("div");
      row.classList.add("tree-view-operation-row");
      row.classList.toggle("is-queued", operation.state === "queued");
      row.dataset.operationId = operation.id;

      let indicator = null;
      if (operation.state === "running") {
        indicator = document.createElement("span");
        indicator.classList.add("tree-view-operation-indicator");
        indicator.classList.add("loading", "loading-spinner-tiny", "inline-block");
        const stateLabel = operation.phase === "cancelling" ? "Cancelling" : "Running";
        indicator.title = stateLabel;
        indicator.setAttribute("role", "img");
        indicator.setAttribute("aria-label", stateLabel);
      }

      const kind = getOperationKind(operation.operation);
      const kindIndicator = document.createElement("span");
      kindIndicator.classList.add("icon", kind.icon, "tree-view-operation-kind");
      kindIndicator.title = kind.label;
      kindIndicator.setAttribute("role", "img");
      kindIndicator.setAttribute("aria-label", kind.label);

      const label = document.createElement("span");
      label.classList.add("tree-view-operation-label");
      label.textContent = this.getOperationLabel(operation);

      const actionLabel = operation.state === "queued" ? "Remove from queue" : "Cancel operation";
      row.title = [
        operation.cancelRequested ? "Cancellation requested" : `${actionLabel} with left click`,
        operation.sourcePath,
        operation.destinationPath,
      ]
        .filter(Boolean)
        .join("\n");
      if (operation.cancelRequested) {
        row.setAttribute("aria-disabled", "true");
      } else {
        row.classList.add("is-cancellable");
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.setAttribute(
          "aria-label",
          `${operation.state === "queued" ? "Queued" : "Running"} ${kind.label}: ${path.basename(operation.sourcePath)}. ${actionLabel}`,
        );
        const cancel = (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.fileOperationProcess.cancel(operation.id);
        };
        row.addEventListener("click", cancel);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") cancel(event);
        });
      }

      row.append(kindIndicator, label);
      if (indicator) row.appendChild(indicator);
      this.operationList.appendChild(row);
    }
  }

  renderCurrentOperationStatus() {
    const operation = this.currentFileOperation;
    if (!operation) return;
    const row = this.operationList.querySelector(`[data-operation-id="${operation.id}"]`);
    const label = row?.querySelector(".tree-view-operation-label");
    if (label) label.textContent = this.getOperationLabel(operation);
  }

  getOperationLabel(operation) {
    const parts = [path.basename(operation.sourcePath)];
    if (operation.state !== "queued") {
      if (operation.entries > 1) {
        parts.push(`${operation.entries} items`);
      } else {
        const size = formatBytes(operation.bytesTotal);
        if (size) parts.push(size);
      }
      const elapsed = Math.floor((Date.now() - operation.startedAt) / 1000);
      parts.push(elapsed === 0 ? "<1s" : `${elapsed}s`);
    }
    return parts.join(" · ");
  }

  async resolveFileOperationConflict({ relativePath }) {
    const chosen = await lumine.window.confirm({
      message: `'${relativePath}' already exists`,
      detail: "Do you want to replace it?",
      buttons: ["Replace file", "Skip", "Cancel"],
    });
    return ["replace", "skip", "cancel"][chosen] ?? "cancel";
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  getTitle() {
    return "Project";
  }

  getIconName() {
    return "file-submodule";
  }

  getURI() {
    return TREE_VIEW_URI;
  }

  setTreeAppearance(appearance) {
    this.element.classList.toggle("tree-view-classic", appearance === "classic");
  }

  setStickyHeaderMode(mode) {
    this.stickyHeaderMode = mode;
    this.element.classList.toggle("sticky-headers", mode !== "none");

    if (mode === "none") {
      this.renderStickyHeaderEntries([]);
    } else {
      this.scheduleStickyHeadersUpdate();
    }
  }

  scheduleStickyHeadersUpdate() {
    if (this.stickyHeaderMode === "none" || this.stickyHeaderUpdateFrame != null) return;

    this.stickyHeaderUpdateFrame = requestAnimationFrame(() => {
      this.stickyHeaderUpdateFrame = null;
      this.updateStickyHeaderOverlay();
    });
  }

  updateStickyHeadersOnScroll() {
    if (this.stickyHeaderMode === "none") return;

    if (this.stickyHeaderUpdateFrame != null) {
      cancelAnimationFrame(this.stickyHeaderUpdateFrame);
      this.stickyHeaderUpdateFrame = null;
    }
    this.updateStickyHeaderOverlay();
  }

  // Programmatic scrolls go through these so the cached position stays
  // authoritative; scrolls the element performs on its own (wheel, scrollbar,
  // scrollIntoView) land in the scroll listener, which is the one place the
  // element is read back. A value past the scrollable end is clamped by the
  // element and the cache corrects itself on the scroll event it causes.
  // An unchanged value is not written at all: assigning scrollTop forces
  // layout just as reading it does — the engine must clamp against the
  // current scroll range — and the rebuild anchor restores the same position
  // far more often than it moves it.
  // Clamped against the row model rather than the element, because the element
  // is silent about the clamp it performs: a value past the scrollable end
  // lands where the scroller already was, and a scroll that does not move
  // fires no event to correct the cache with. The cache would then name an
  // offset the tree is not at, and `collectStickyHeaderEntries` turns an offset
  // into a row — so a stale one pins the root of some row in the middle of the
  // tree over whatever is actually at the top. The model already knows the
  // content height, and the scrollport is measured after layout, so neither
  // read costs anything here.
  maxScrollTop() {
    if (!(this.scrollportHeight > 0)) return Infinity;
    return Math.max(0, (this.rowTops[this.rowTops.length - 1] ?? 0) - this.scrollportHeight);
  }

  maxScrollLeft() {
    if (!(this.scrollportWidth > 0)) return Infinity;
    return Math.max(0, this.contentWidth - this.scrollportWidth);
  }

  setScrollTop(scrollTop) {
    const value = Math.min(Math.max(0, scrollTop), this.maxScrollTop());
    if (value === this.scrollPosition.top) return;
    this.scrollPosition.top = value;
    this.scroller.scrollTop = value;
  }

  setScrollLeft(scrollLeft) {
    const value = Math.min(Math.max(0, scrollLeft), this.maxScrollLeft());
    if (value === this.scrollPosition.left) return;
    this.scrollPosition.left = value;
    this.scroller.scrollLeft = value;
  }

  // Runs from the ResizeObserver, after the engine's own layout pass, so these
  // reads never force a style recalculation.
  refreshViewportMetrics() {
    this.viewportMetricsFresh = true;
    this.contentWidth = Math.ceil(this.list.getBoundingClientRect().width);
    this.scrollportWidth = this.scroller.clientWidth;
    this.scrollportHeight = this.scroller.clientHeight;
    // The element is authoritative for the offset here too. Destroying and
    // rebuilding a scroll box resets it to the top — a dock hiding its item,
    // the stylesheet redraw below — and the engine fires no scroll event for a
    // reset it performs itself, so this is the only place the two are known to
    // have parted. A zero-sized scrollport is that destroyed state rather than
    // a scroll to the top, so the cache is left alone until the tree is back on
    // screen and can be asked where it really is.
    if (this.scrollportHeight > 0) {
      this.scrollPosition.top = this.scroller.scrollTop;
      this.scrollPosition.left = this.scroller.scrollLeft;
    }
    this.updateStickyHeaderOverlay();
  }

  updateStickyHeaderOverlay() {
    const scrollLeft = this.scrollPosition.left;
    const stickyLeft = -scrollLeft;
    if (this.stickyHeaderLeft !== stickyLeft) {
      this.stickyHeaderLeft = stickyLeft;
      this.stickyHeaderList.style.left = `${stickyLeft}px`;
    }
    // The cached width, not a fresh measurement: this runs on every scroll
    // event, and reading the list back would force a layout each time.
    this.stickyHeaderList.style.width = this.contentWidth > 0 ? `${this.contentWidth}px` : "100%";
    const clipLeft = Math.max(0, scrollLeft);
    const clipRight = Math.max(0, this.contentWidth - clipLeft - this.scrollportWidth);
    const clipPath =
      this.contentWidth > 0 && this.scrollportWidth > 0 && (clipLeft > 0 || clipRight > 0)
        ? `inset(0px ${clipRight}px 0px ${clipLeft}px)`
        : "";
    if (this.stickyHeaderClipPath !== clipPath) {
      this.stickyHeaderClipPath = clipPath;
      this.stickyHeaderList.style.clipPath = clipPath;
    }
    this.renderStickyHeaderEntries(this.collectStickyHeaderEntries());
  }

  collectStickyHeaderEntries() {
    if (this.stickyHeaderMode === "none" || this.visibleRows.length === 0) return [];

    const contentHeight = this.rowTops[this.rowTops.length - 1] ?? 0;
    if (this.scrollportHeight > 0 && contentHeight <= this.scrollportHeight) return [];

    const scrollTop = this.scrollPosition.top;
    const firstIndex = this.indexAtOffset(scrollTop);
    let root = this.visibleRows[firstIndex];
    while (root?.parent) root = root.parent;
    if (!root || (!root.projectRoot && !root.specialRoot)) return [];

    const rootBottom = this.rowTops[root.subtreeEndIndex] ?? root.top + root.height;
    if (scrollTop < root.top || scrollTop >= rootBottom) return [];

    const entries = [root];
    if (this.stickyHeaderMode === "roots") return entries;

    let directory = root;
    let slot = scrollTop + root.height;

    while (directory.isExpanded && slot < rootBottom) {
      const probe = this.visibleRows[this.indexAtOffset(slot)];
      if (!probe || probe.index >= directory.subtreeEndIndex) break;

      let child = probe;
      while (child?.parent && child.parent !== directory) child = child.parent;
      if (!child || child.parent !== directory || child.kind !== "directory" || !child.isExpanded) {
        break;
      }

      const childBottom = this.rowTops[child.subtreeEndIndex] ?? child.top + child.height;
      if (child.top >= slot || childBottom <= slot) break;

      entries.push(child);
      slot += child.height;
      directory = child;
    }

    return entries;
  }

  renderStickyHeaderEntries(entries) {
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < entries.length &&
      commonPrefixLength < this.stickyHeaderEntries.length &&
      entries[commonPrefixLength] === this.stickyHeaderEntries[commonPrefixLength]
    ) {
      commonPrefixLength++;
    }

    while (this.stickyHeaderList.children.length > commonPrefixLength) {
      this.stickyHeaderList.lastElementChild.treeRowView?.destroy();
    }

    for (let index = commonPrefixLength; index < entries.length; index++) {
      const entry = entries[index];
      const view = new TreeRowView(this, "directory", { sticky: true });
      const element = view.bind(entry);
      element.treeRowView = view;
      this.stickyHeaderList.appendChild(element);
    }

    this.stickyHeaderEntries = entries.slice();
    let stackTop = 0;
    let stackBottom = 0;
    for (let index = 0; index < this.stickyHeaderList.children.length; index++) {
      const child = this.stickyHeaderList.children[index];
      const entry = entries[index];
      child.treeRowView?.sync();
      // Not only on creation: every stylesheet that arrives during startup
      // re-measures the row grid, and a mounted sticky copy must follow it the
      // way renderVisibleRows refreshes real rows. A copy trusting the height
      // it was born with ends up a stale band over rows laid out on the new
      // grid, and the whole stack below it lands offset.
      child.style.height = `${entry.height}px`;
      child.style.setProperty("--tree-view-depth", entry.depth);

      const subtreeBottom = this.rowTops?.[entry.subtreeEndIndex];
      const visibleSubtreeBottom =
        subtreeBottom == null ? Infinity : subtreeBottom - this.scrollPosition.top;
      // Push an ending header upward as its following sibling reaches the
      // sticky stack. Ancestors have a higher z-index, so nested headers slide
      // underneath them rather than painting over them.
      const pushOffset = Math.min(
        entry.height,
        Math.max(0, stackTop + entry.height - visibleSubtreeBottom),
      );
      child.style.clipPath = "";
      child.style.top = pushOffset > 0 ? `-${pushOffset}px` : "";
      child.style.zIndex = entries.length - index;
      stackTop += entry.height;
      stackBottom = Math.max(stackBottom, stackTop - pushOffset);
    }

    const contentHeight = this.rowTops?.at(-1) ?? 0;
    const boundaryOffset = this.scrollPosition.top + stackBottom;
    const followingEntry =
      boundaryOffset < contentHeight ? this.visibleRows[this.indexAtOffset(boundaryOffset)] : null;
    const selectionContinuesBelow =
      entries.length > 0 &&
      this.selectedEntries.has(entries.at(-1)) &&
      this.selectedEntries.has(followingEntry);
    this.stickyHeaderList.classList.toggle("selection-continues-below", selectionContinuesBelow);

    this.stickyHeaderLayer.hidden = entries.length === 0;
    if (entries.length === 0) {
      this.stickyHeaderList.style.height = "";
      return;
    }
    // The visible bottom of the stack, not the sum of its heights: the list is
    // an opaque surface, and while a header is being pushed out the sum leaves
    // a dead band below the stack that covers the very row sliding in to
    // replace it — one band per simultaneously departing header.
    this.stickyHeaderList.style.height = `${stackBottom}px`;
  }

  clearStickyHeaderViews() {
    for (const child of Array.from(this.stickyHeaderList.children)) {
      child.treeRowView?.destroy();
    }
    this.stickyHeaderList.replaceChildren();
    this.stickyHeaderEntries = [];
  }

  registerTreeEntry(entry, { project = true } = {}) {
    this.treeEntries.add(entry);
    if (project) this.projectEntries.add(entry);
    return entry;
  }

  unregisterTreeEntry(entry) {
    for (const child of entry.children.slice()) this.unregisterTreeEntry(child);
    entry.children = [];

    const rowView = this.rowViews.get(entry);
    if (rowView) this.destroyRowView(entry, rowView);
    this.selectedEntries.delete(entry);
    if (this.lastFocusedEntry === entry) this.lastFocusedEntry = null;
    entry.subscriptions?.dispose();
    entry.subscriptions = null;
    this.treeEntries.delete(entry);
    this.projectEntries.delete(entry);
  }

  createDirectoryTreeEntry(
    directory,
    parent = null,
    { projectRoot = false, special = false, section = null, entryClassName = null } = {},
  ) {
    const shouldExpand = directory.expansionState.isExpanded;
    const entry = new TreeEntry(this, {
      item: directory,
      kind: "directory",
      parent,
      projectRoot,
      special,
      section: section ?? parent?.section ?? null,
      entryClassName: entryClassName ?? parent?.entryClassName ?? null,
    });
    entry.subscriptions = new CompositeDisposable(
      directory.onDidStatusChange(() => {
        entry.syncViews();
        this.scheduleStickyHeadersUpdate();
      }),
      directory.onDidAddEntries((addedEntries) => {
        this.addDirectoryTreeEntries(entry, addedEntries);
      }),
      directory.onDidRemoveEntries((removedEntries) => {
        this.removeDirectoryTreeEntries(entry, removedEntries);
      }),
    );
    this.registerTreeEntry(entry, { project: !entry.section });

    if (shouldExpand) {
      Promise.resolve().then(() => {
        if (this.treeEntries.has(entry)) entry.expand();
      });
    }
    return entry;
  }

  createFileTreeEntry(
    file,
    parent,
    { special = false, section = null, entryClassName = null, exists = true } = {},
  ) {
    const entry = new TreeEntry(this, {
      item: file,
      kind: "file",
      parent,
      special,
      section: section ?? parent?.section ?? null,
      entryClassName: entryClassName ?? parent?.entryClassName ?? null,
      exists,
    });
    entry.subscriptions = new CompositeDisposable(
      file.onDidStatusChange(() => {
        entry.syncViews();
        this.scheduleStickyHeadersUpdate();
      }),
    );
    return this.registerTreeEntry(entry, { project: !entry.section });
  }

  addDirectoryTreeEntries(parent, addedEntries) {
    for (const item of addedEntries) {
      const entry =
        item instanceof Directory
          ? this.createDirectoryTreeEntry(item, parent)
          : this.createFileTreeEntry(item, parent);
      const index = Math.min(
        item.indexInParentDirectory ?? parent.children.length,
        parent.children.length,
      );
      parent.children.splice(index, 0, entry);
    }
    this.rebuildVisibleRows();
  }

  removeDirectoryTreeEntries(parent, removedEntries) {
    for (let index = parent.children.length - 1; index >= 0; index--) {
      const entry = parent.children[index];
      if (!removedEntries.has(entry.item)) continue;
      parent.children.splice(index, 1);
      this.unregisterTreeEntry(entry);
    }
    this.rebuildVisibleRows();
  }

  async expandTreeEntry(entry, isRecursive = false) {
    if (!entry || entry.kind !== "directory") return;
    if (entry.specialRoot) return entry.section.expand();
    if (!entry.directory?.expand) return Promise.resolve();

    if (!entry.isExpanded) {
      entry.isExpanded = true;
      entry.syncViews();
      this.rebuildVisibleRows();
      await entry.directory.expand();
    }

    if (isRecursive) {
      for (const child of entry.children.slice()) {
        if (child.kind === "directory") await child.expand(true);
      }
    }
    this.rebuildVisibleRows();
  }

  collapseTreeEntry(entry, isRecursive = false) {
    if (!entry || entry.kind !== "directory") return;
    if (entry.specialRoot) return entry.section.collapse();
    if (!entry.directory?.collapse || !entry.isExpanded) return;

    if (isRecursive) {
      for (const child of entry.children.slice()) {
        if (child.kind === "directory") child.collapse(true);
      }
    }

    for (const child of entry.children.slice()) this.unregisterTreeEntry(child);
    entry.children = [];
    entry.isExpanded = false;
    entry.directory.collapse();
    entry.syncViews();

    if (!this.selectedEntries.has(entry) && this.selectedEntries.size === 0) {
      this.selectEntry(entry);
    }
    this.rebuildVisibleRows();
  }

  reloadTreeEntry(entry) {
    if (!entry || entry.kind !== "directory") return;
    if (entry.specialRoot) return entry.section.refresh();
    entry.directory?.reload?.();
  }

  rebuildVisibleRows({ preserveScroll = true } = {}) {
    if (!this.scroller || !this.list) return;

    const oldAnchor =
      preserveScroll && this.visibleRows.length > 0
        ? this.visibleRows[this.indexAtOffset(this.scrollPosition.top)]
        : null;
    const oldAnchorOffset = oldAnchor ? this.scrollPosition.top - oldAnchor.top : 0;
    const rows = [];
    const rowTops = [0];

    const appendEntry = (entry, depth) => {
      entry.depth = depth;
      entry.index = rows.length;
      entry.top = rowTops[rowTops.length - 1];
      entry.height =
        entry.projectRoot || entry.specialRoot ? this.rootRowHeight : this.regularRowHeight;
      rows.push(entry);
      rowTops.push(entry.top + entry.height);

      if (entry.kind === "directory" && entry.isExpanded) {
        for (const child of entry.children) appendEntry(child, depth + 1);
      }
      entry.subtreeEndIndex = rows.length;
    };

    for (const section of this.specialRoots) {
      const isRenderable = section.isRenderable();
      section.element.hidden = !isRenderable;
      if (isRenderable) appendEntry(section.root, 0);
    }
    for (const root of this.roots) appendEntry(root, 0);

    this.visibleRows = rows;
    this.rowTops = rowTops;
    this.viewport.hidden = rows.length === 0;

    if (oldAnchor && rows.includes(oldAnchor)) {
      this.setScrollTop(oldAnchor.top + oldAnchorOffset);
    }

    this.renderVisibleRows();
  }

  measureRowHeights() {
    if (!this.rowMetrics?.isConnected) return false;

    const regularHeight = this.regularRowMetricsProbe.getBoundingClientRect().height;
    const rootHeight = this.rootHeaderMetricsProbe.getBoundingClientRect().height;

    const nextRegularHeight = regularHeight || this.regularRowHeight;
    const nextRootHeight = rootHeight || this.rootRowHeight;
    const changed =
      nextRegularHeight !== this.regularRowHeight || nextRootHeight !== this.rootRowHeight;
    if (changed) {
      this.regularRowHeight = nextRegularHeight;
      this.rootRowHeight = nextRootHeight;
    }
    return changed;
  }

  indexAtOffset(offset) {
    if (this.visibleRows.length === 0) return 0;
    const boundedOffset = Math.max(0, Math.min(offset, this.rowTops[this.rowTops.length - 1]));
    let low = 0;
    let high = this.visibleRows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rowTops[middle + 1] <= boundedOffset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Math.min(low, this.visibleRows.length - 1);
  }

  renderVisibleRows() {
    if (!this.scroller || this.visibleRows.length === 0) {
      this.destroyRowViews();
      this.contentWidth = 0;
      this.renderStickyHeaderEntries([]);
      return;
    }

    const needed = new Set(this.visibleRows);

    for (const [entry, view] of Array.from(this.rowViews)) {
      if (!needed.has(entry)) this.destroyRowView(entry, view);
    }

    const viewsByParent = new Map();
    for (const entry of this.visibleRows) {
      let view = this.rowViews.get(entry);
      if (!view) {
        view = new TreeRowView(this, entry.kind);
        view.bind(entry);
        this.rowViews.set(entry, view);
      } else {
        view.element.style.height = `${entry.height}px`;
        view.element.style.setProperty("--tree-view-depth", entry.depth);
        view.sync();
      }

      const parent = entry.section ? entry.section.element : this.list;
      let views = viewsByParent.get(parent);
      if (!views) viewsByParent.set(parent, (views = []));
      views.push(view);
    }

    for (const [parent, views] of viewsByParent) {
      let reference =
        parent === this.list
          ? Array.from(parent.children).find((child) => child.classList.contains("tree-view-row"))
          : parent.firstElementChild;
      for (const view of views) {
        if (view.element === reference) {
          reference = reference.nextElementSibling;
        } else {
          parent.insertBefore(view.element, reference);
        }
      }
    }

    // Every logically visible row is mounted, so the list sizes itself to the
    // widest one: `width: max-content` with `min-width: 100%`. Measuring that
    // width here would force a style recalculation of the subtrees this render
    // just mounted, on the input task that mounted them — with a session's
    // worth of stylesheets loaded, that recalculation is the dominant cost of
    // expanding a directory. The ResizeObserver delivers the same numbers after
    // the engine's own layout pass, where reading them is free; until its first
    // delivery (initial render, or a headless window that throttles rendering)
    // the synchronous measurement stands in.
    if (!this.viewportMetricsFresh) {
      this.contentWidth = Math.ceil(this.list.getBoundingClientRect().width);
      this.scrollportWidth = this.scroller.clientWidth;
      this.scrollportHeight = this.scroller.clientHeight;
    }
    this.updateStickyHeaderOverlay();
  }

  destroyRowView(entry, view) {
    if (this.rowViews.get(entry) === view) this.rowViews.delete(entry);
    view.destroy();
  }

  destroyRowViews() {
    for (const [entry, view] of Array.from(this.rowViews)) {
      this.destroyRowView(entry, view);
    }
  }

  treeEntryForElement(element) {
    return element?.closest?.(".entry, .tree-view-sticky-header")?.treeEntry ?? null;
  }

  elementForTreeEntry(entry) {
    return this.rowViews.get(entry)?.element ?? null;
  }

  treeEntryForPath(entryPath) {
    let sectionMatchEntry = null;
    let realPathMatchEntry = null;
    let bestMatchEntry = null;
    let bestMatchLength = 0;
    for (const entry of this.treeEntries) {
      const currentPath = entry.getPath();
      // A path pinned in a root section also lives under a project folder, and
      // the project copy is the one to reveal, expand and scroll to.
      if (currentPath === entryPath) {
        if (!entry.section) return entry;
        sectionMatchEntry ??= entry;
        continue;
      }
      if (realPathMatchEntry == null && !entry.section && entry.isPathEqual(entryPath)) {
        realPathMatchEntry = entry;
      }
      if (
        this.projectEntries.has(entry) &&
        entry.contains(entryPath) &&
        currentPath.length > bestMatchLength
      ) {
        bestMatchEntry = entry;
        bestMatchLength = currentPath.length;
      }
    }
    return realPathMatchEntry ?? bestMatchEntry ?? sectionMatchEntry;
  }

  // `getDefaultLocation` is the hook the workspace asks when it opens an item,
  // so the setting has to be spelled here to have any effect at all.
  getDefaultLocation() {
    return lumine.config.get("tree-view.showOnRightSide") ? "right" : "left";
  }

  getAllowedLocations() {
    return ["left", "right"];
  }

  isPersistentDockItem() {
    return true;
  }

  getPreferredWidth() {
    return Math.max(this.contentWidth, this.scroller.scrollWidth);
  }

  onDirectoryCreated(callback) {
    return this.emitter.on("directory-created", callback);
  }

  onEntryCopied(callback) {
    return this.emitter.on("entry-copied", callback);
  }

  onWillDeleteEntry(callback) {
    return this.emitter.on("will-delete-entry", callback);
  }

  onEntryDeleted(callback) {
    return this.emitter.on("entry-deleted", callback);
  }

  onDeleteEntryFailed(callback) {
    return this.emitter.on("delete-entry-failed", callback);
  }

  onWillMoveEntry(callback) {
    return this.emitter.on("will-move-entry", callback);
  }

  onEntryMoved(callback) {
    return this.emitter.on("entry-moved", callback);
  }

  onMoveEntryFailed(callback) {
    return this.emitter.on("move-entry-failed", callback);
  }

  onFileCreated(callback) {
    return this.emitter.on("file-created", callback);
  }

  handleEvents() {
    this.scroller.addEventListener(
      "scroll",
      () => {
        // The one context where the element is authoritative: native scrolling
        // (wheel, scrollbar drag, scrollIntoView) lands here, and reading
        // during scroll dispatch is free of forced layout.
        this.scrollPosition.top = this.scroller.scrollTop;
        this.scrollPosition.left = this.scroller.scrollLeft;
        this.updateStickyHeadersOnScroll();
      },
      { passive: true },
    );

    this.element.addEventListener("click", (e) => {
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
        return this.entryClicked(e);
      }
    });

    this.element.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.element.addEventListener("mouseup", (e) => this.onMouseUp(e));
    this.element.addEventListener("focusout", () => {
      requestAnimationFrame(() => {
        if (!this.element.contains(document.activeElement)) {
          this.addProjectsView?.clearSelection();
        }
      });
    });
    this.element.addEventListener("dragstart", (e) => this.onDragStart(e));
    this.element.addEventListener("dragenter", (e) => this.onDragEnter(e));
    this.element.addEventListener("dragleave", (e) => this.onDragLeave(e));
    this.element.addEventListener("dragover", (e) => this.onDragOver(e));
    this.element.addEventListener("drop", (e) => this.onDrop(e));

    lumine.commands.add(this.element, {
      "core:move-up": (e) => this.moveUp(e),
      "core:move-down": (e) => this.moveDown(e),
      "core:select-up": (e) => this.extendSelection(-1, e),
      "core:select-down": (e) => this.extendSelection(1, e),
      "core:page-up": (e) => this.pageUp(e),
      "core:page-down": (e) => this.pageDown(e),
      "core:move-to-top": (e) => this.scrollToTop(e),
      "core:move-to-bottom": (e) => this.scrollToBottom(e),

      "tree-view:expand-item": {
        description: "Preview the selected file, or expand the selected folder.",
        didDispatch: () => this.openSelectedEntry({ pending: true }, true),
      },
      "tree-view:recursive-expand-directory": {
        description: "Expand the selected folder and every folder inside it.",
        didDispatch: () => {
          this.expandDirectory(true);
        },
      },
      "tree-view:collapse-directory": {
        description: "Collapse the folder holding the selection.",
        didDispatch: () => this.collapseDirectory(),
      },
      "tree-view:recursive-collapse-directory": {
        description: "Collapse the selected folder and every folder inside it.",
        didDispatch: () => {
          this.collapseDirectory(true);
        },
      },
      "tree-view:collapse-all": {
        description: "Collapse every folder in the tree.",
        didDispatch: () => this.collapseDirectory(true, true),
      },

      "tree-view:open-selected-entry": {
        description: "Open the selected file for good, not as a preview.",
        didDispatch: () => this.openSelectedEntry(),
      },
      "tree-view:preview-selected-entry": {
        description: "Open the selected file as a preview the next one replaces.",
        didDispatch: () => this.previewSelectedEntry(),
      },
      "tree-view:open-selected-entry-right": {
        description: "Open the selected file in a pane to the right.",
        didDispatch: () => this.openSelectedEntryRight(),
      },
      "tree-view:open-selected-entry-left": {
        description: "Open the selected file in a pane to the left.",
        didDispatch: () => this.openSelectedEntryLeft(),
      },
      "tree-view:open-selected-entry-up": {
        description: "Open the selected file in a pane above.",
        didDispatch: () => this.openSelectedEntryUp(),
      },
      "tree-view:open-selected-entry-down": {
        description: "Open the selected file in a pane below.",
        didDispatch: () => this.openSelectedEntryDown(),
      },

      "tree-view:move": {
        description: "Move the selected entry to a path you type.",
        didDispatch: () => this.moveSelectedEntry(),
      },
      "tree-view:copy": {
        description: "Copy the selected entries to the system clipboard.",
        didDispatch: () => this.copySelectedEntries(),
      },
      "tree-view:cut": {
        description: "Cut the selected entries to the system clipboard.",
        didDispatch: () => this.cutSelectedEntries(),
      },
      "tree-view:paste": {
        description: "Paste the clipboard entries into the selected folder.",
        didDispatch: () => this.pasteEntries(),
      },

      "tree-view:copy-full-path": {
        description: "Copy the entry's full path from the filesystem root.",
        didDispatch: () => this.copySelectedEntryPath(false),
      },
      "tree-view:open-in-new-window": {
        description: "Open the selected folder as a project in a new window.",
        didDispatch: () => this.openSelectedEntryInNewWindow(),
      },
      "tree-view:open-in-this-window": {
        description: "Open the selected folder as the project of this window.",
        didDispatch: () => this.openSelectedEntryInThisWindow(),
      },
      "tree-view:copy-project-path": {
        description: "Copy the entry's path relative to its project root.",
        didDispatch: () => this.copySelectedEntryPath(true),
      },

      "tree-view:unfocus": {
        description: "Return focus to the editor, leaving the tree open.",
        didDispatch: () => this.unfocus(),
      },

      "tree-view:toggle-vcs-ignored-files": {
        description: "Show or hide the files the repository is ignoring.",
        didDispatch: () => toggleConfig(`tree-view.hideVcsIgnoredFiles`),
      },
      "tree-view:toggle-ignored-names": {
        description: "Show or hide the names the Ignored Names setting hides.",
        didDispatch: () => toggleConfig(`tree-view.hideIgnoredNames`),
      },
      "tree-view:remove-project-folder": {
        description: "Drop the selected folder from the project, leaving it on disk.",
        didDispatch: (e) => this.removeProjectFolder(e),
      },

      // Written out rather than generated over 1..9. The loop that used to
      // register these put both the name and the description past what the
      // command check can read, and a pane number is exactly the kind of thing
      // a reader wants spelled out.
      "tree-view:open-selected-entry-in-pane-1": {
        description: "Open the selected file in the first pane.",
        didDispatch: () => this.openSelectedEntryInPane(0),
      },
      "tree-view:open-selected-entry-in-pane-2": {
        description: "Open the selected file in the second pane.",
        didDispatch: () => this.openSelectedEntryInPane(1),
      },
      "tree-view:open-selected-entry-in-pane-3": {
        description: "Open the selected file in the third pane.",
        didDispatch: () => this.openSelectedEntryInPane(2),
      },
      "tree-view:open-selected-entry-in-pane-4": {
        description: "Open the selected file in the fourth pane.",
        didDispatch: () => this.openSelectedEntryInPane(3),
      },
      "tree-view:open-selected-entry-in-pane-5": {
        description: "Open the selected file in the fifth pane.",
        didDispatch: () => this.openSelectedEntryInPane(4),
      },
      "tree-view:open-selected-entry-in-pane-6": {
        description: "Open the selected file in the sixth pane.",
        didDispatch: () => this.openSelectedEntryInPane(5),
      },
      "tree-view:open-selected-entry-in-pane-7": {
        description: "Open the selected file in the seventh pane.",
        didDispatch: () => this.openSelectedEntryInPane(6),
      },
      "tree-view:open-selected-entry-in-pane-8": {
        description: "Open the selected file in the eighth pane.",
        didDispatch: () => this.openSelectedEntryInPane(7),
      },
      "tree-view:open-selected-entry-in-pane-9": {
        description: "Open the selected file in the ninth pane.",
        didDispatch: () => this.openSelectedEntryInPane(8),
      },
    });

    // Update the tree view…
    this.disposables.add(
      // …when the active pane changes.
      lumine.workspace.getCenter().onDidChangeActivePaneItem(() => {
        // Don't steal selection from special root sections
        if (!(this.hasFocus() && this.getSelectedEntries().some((entry) => entry.special))) {
          this.selectActiveFile();
        }
        if (lumine.config.get("tree-view.autoReveal")) {
          // `center: false` — this fires on every tab switch, so it scrolls
          // only when the row is actually out of view, and then by the least
          // it can. Centering here would haul the tree around behind a user
          // who never asked for it; the explicit reveal command still centers.
          this.revealActiveFile({ show: false, focus: false, center: false });
        }
      }),
      // …when we detect new/deleted files in the project.
      lumine.project.onDidChangePaths(debounce(() => this.updateRoots(), 50)),
      // …when a git repository is added (e.g. git init) or destroyed (e.g. .git
      // deleted), so items subscribe to the new repo or lose their git colors.
      lumine.repositories.onDidAddRepository(debounce(() => this.repositoriesChanged(), 50)),
      lumine.repositories.observeRepositories((repo) => {
        this.disposables.add(repo.onDidDestroy(debounce(() => this.repositoriesChanged(), 50)));
      }),
      // …when the user changes any of the settings that affect what gets shown
      // (and in what order).
      lumine.config.onDidChange("tree-view.hideVcsIgnoredFiles", () => this.updateRoots()),
      lumine.config.onDidChange("tree-view.hideIgnoredNames", () => this.updateRoots()),
      lumine.config.onDidChange("core.ignoredNames", () => this.updateRoots()),
      lumine.config.onDidChange("tree-view.sortFoldersBeforeFiles", () => this.updateRoots()),
      lumine.config.onDidChange("tree-view.squashDirectoryNames", () => this.updateRoots()),
    );
  }

  toggle() {
    return lumine.workspace.toggle(this);
  }

  // `location` forces which dock the tree opens in; without it the workspace
  // decides, which keeps wherever the user last dragged the tree to.
  async show(focus = false, location = null) {
    const activeElement = focus ? null : document.activeElement;
    const activePane = focus ? null : lumine.workspace.getActivePane();

    await lumine.workspace.open(this, {
      searchAllPanes: true,
      activatePane: focus,
      activateItem: true,
      ...(location ? { location } : null),
    });
    let container = lumine.workspace.paneContainerForURI(this.getURI());
    if (!container) {
      console.error(`Cannot find container for:`, this.getURI());
      return;
    }
    container.show();
    this.scheduleStickyHeadersUpdate();
    if (focus) {
      this.focus();
    } else if (
      activeElement &&
      activeElement !== document.body &&
      activeElement.isConnected &&
      document.activeElement !== activeElement
    ) {
      activeElement.focus();
    } else if (activePane && lumine.workspace.getActivePane() !== activePane) {
      activePane.activate();
    }
  }

  hide() {
    return lumine.workspace.hide(this);
  }

  // `getDefaultLocation` is only consulted when the item is opened, so changing
  // the side of an already-open tree means taking it out of the dock it is in
  // and opening it again. Passing `moved` keeps the item alive through the
  // removal; without it the workspace treats the tree as closed and offers it
  // back through `reopenItem`. The location is passed explicitly because a
  // dragged item has its dock remembered, and that memory would otherwise win
  // over the setting the user just changed.
  async moveToPreferredLocation() {
    const location = this.getDefaultLocation();
    const pane = lumine.workspace.paneForItem(this);
    if (!pane) return;
    if (lumine.workspace.paneContainerForItem(this).getLocation() === location) return;
    const hadFocus = this.hasFocus();
    pane.removeItem(this, true);
    await this.show(hadFocus, location);
  }

  focus() {
    return this.element.focus();
  }

  unfocus() {
    return lumine.workspace.getCenter().activate();
  }

  hasFocus() {
    return document.activeElement === this.element;
  }

  toggleFocus() {
    if (this.hasFocus()) {
      return this.unfocus();
    } else {
      return this.show(true);
    }
  }

  // Special roots

  addSpecialRoot(config, expansionStates) {
    const section = new TreeRootSection(this, config, expansionStates);
    this.specialRoots.push(section);
    this.viewport.hidden =
      this.roots.length === 0 && !this.specialRoots.some((candidate) => candidate.isRenderable());
    this.rebuildVisibleRows();
    return section;
  }

  removeSpecialRoot(section) {
    const index = this.specialRoots.indexOf(section);
    if (index === -1) return;
    section.destroy();
    this.specialRoots.splice(index, 1);
    this.viewport.hidden =
      this.roots.length === 0 && !this.specialRoots.some((candidate) => candidate.isRenderable());
    this.rebuildVisibleRows();
  }

  // A closed section keeps its entries registered so it can reopen without
  // reading the disk again, so nothing drops them out of the selection the way
  // `collapseTreeEntry` does for a directory it unregisters. Hand the selection
  // to a row that stays on screen rather than leaving it on one nobody can see.
  releaseSelectionInSection(section) {
    const stays = section.isRenderable();
    const leaving = [];
    const collect = (entry) => {
      leaving.push(entry);
      for (const child of entry.children) collect(child);
    };
    for (const entry of section.entries) collect(entry);
    if (!stays) leaving.push(section.root);

    let released = false;
    for (const entry of leaving) {
      if (!this.selectedEntries.delete(entry)) continue;
      released = true;
      entry.syncViews();
      if (this.lastFocusedEntry === entry) this.lastFocusedEntry = null;
    }
    if (!released) return;

    if (this.selectedEntries.size > 0) {
      this.scheduleStickyHeadersUpdate();
      return;
    }
    this.selectEntry(stays ? section.root : this.roots[0]);
  }

  refreshSpecialRoots() {
    for (const section of this.specialRoots) {
      section.refresh();
    }
    this.rebuildVisibleRows();
  }

  entryClicked(event) {
    let entry = this.treeEntryForElement(event.target);
    if (!entry) return;

    let { detail = 1 } = event;
    let isRecursive = event.altKey ?? false;

    if (entry.kind === "directory") {
      // Alt+click: open externally via open-external service
      if (event.altKey && this.openExternalService) {
        this.selectEntry(entry);
        requestAnimationFrame(() => {
          this.openExternalService.openExternal(entry.getPath());
        });
        return;
      }
      let doubleClick = lumine.config.get("tree-view.dirDoubleClick");
      if (doubleClick) {
        const disclosureClicked = event.target.closest?.(".tree-view-disclosure") != null;
        if (disclosureClicked) {
          if (detail === 1) {
            this.selectEntry(entry);
            entry.toggleExpansion(isRecursive);
          }
          return;
        }
        // Double-click mode
        if (detail === 1) {
          this.selectEntry(entry);
        } else if (detail === 2) {
          entry.toggleExpansion(isRecursive);
        }
      } else {
        // Single-click mode: every click selects and toggles
        this.selectEntry(entry);
        entry.toggleExpansion(isRecursive);
      }
    } else if (entry.kind === "file") {
      // Alt+click: open externally via open-external service
      if (event.altKey && this.openExternalService) {
        this.selectEntry(entry);
        requestAnimationFrame(() => {
          this.openExternalService.openExternal(entry.getPath());
        });
        return;
      }
      let doubleClick = lumine.config.get("tree-view.fileDoubleClick");
      if (doubleClick) {
        // Double-click mode
        if (detail === 1) {
          this.selectEntry(entry);
        } else if (detail === 2) {
          return this.openAfterPromise(entry.getPath(), {
            searchAllPanes: lumine.config.get("tree-view.alwaysOpenExisting"),
          });
        }
      } else {
        // Single-click mode: every click selects and opens
        this.selectEntry(entry);
        return this.fileViewEntryClicked(event);
      }
    }
  }

  fileViewEntryClicked(event) {
    let filePath = this.treeEntryForElement(event.target)?.getPath();
    if (!filePath) return;
    let { detail = 1 } = event;
    let alwaysOpenExisting = lumine.config.get("tree-view.alwaysOpenExisting");
    let allowPendingPaneItems = lumine.config.get("core.allowPendingPaneItems");
    if (detail >= 2) {
      return this.openAfterPromise(filePath, {
        searchAllPanes: alwaysOpenExisting,
      });
    }
    if (allowPendingPaneItems) {
      let openPromise = lumine.workspace.open(filePath, {
        pending: true,
        activatePane: false,
        searchAllPanes: alwaysOpenExisting,
      });
      this.currentlyOpening.set(filePath, openPromise);
      return openPromise.then(() => this.currentlyOpening.delete(filePath));
    }
  }

  openAfterPromise(uri, options) {
    let promise = this.currentlyOpening.get(uri);
    if (promise) {
      return promise.then(() => lumine.workspace.open(uri, options));
    } else {
      return lumine.workspace.open(uri, options);
    }
  }

  // A repository arriving or leaving changes what the loaded entries report,
  // never the tree itself. The shared observer re-routes those models in bounded
  // event-loop slices; rebuilding roots here used to discard the scroll offset.
  repositoriesChanged() {
    if (lumine.isDestroying || !lumine.project) return;
    repositoryStatusObserver.repositoriesChanged();
  }

  // Update the state of the tree view by synchronizing it with the state of
  // the filesystem and the user's current settings.
  updateRoots(expansionStates = {}, selectionState = null) {
    // Repository destruction can schedule this callback while the window is
    // shutting down, after Environment has already cleared its project.
    if (lumine.isDestroying || !lumine.project) return;

    const selectedEntries = this.getSelectedEntries();
    const selectedProjectEntries = selectedEntries.filter((entry) =>
      this.projectEntries.has(entry),
    );
    const retainedSelection = new Set(
      selectedEntries.filter((entry) => !this.projectEntries.has(entry)),
    );
    const selectedPaths =
      selectionState?.selectedPaths ?? selectedProjectEntries.map((entry) => entry.getPath());
    const focusedEntry = this.selectedEntry();
    const focusedPath =
      selectionState?.focusedPath ??
      (focusedEntry && this.projectEntries.has(focusedEntry) ? focusedEntry.getPath() : null);
    const updateGeneration = ++this.rootsUpdateGeneration;
    let oldExpansionStates = {};
    for (let root of this.roots) {
      oldExpansionStates[root.directory.path] = root.directory.serializeExpansionState();
      root.directory.destroy();
      this.unregisterTreeEntry(root);
    }
    this.roots = [];
    let projectPaths = lumine.project.getPaths();
    if (projectPaths.length > 0) {
      this.viewport.hidden = false;
      let addProjectsViewElement = this.element.querySelector("#add-projects-view");
      if (addProjectsViewElement) {
        this.element.removeChild(addProjectsViewElement);
        this.addProjectsView = null;
      }
      if (IgnoredNames == null) {
        IgnoredNames = require("./ignored-names");
      }

      for (let projectPath of projectPaths) {
        let stats = fs.lstatSyncNoException(projectPath);
        if (!stats) continue;

        // Read the date getters from the original Stats object before it is
        // flattened: as of Node 24 atime/mtime/ctime/birthtime are prototype
        // getters, so Object.assign (own enumerable only) drops them.
        const statFlat = Object.assign({}, stats);
        for (let key of ["atime", "birthtime", "ctime", "mtime"]) {
          statFlat[key] = stats[key] && stats[key].getTime();
        }
        stats = statFlat;

        let directory = new Directory({
          name: path.basename(projectPath),
          fullPath: projectPath,
          symlink: false,
          isRoot: true,
          expansionState: expansionStates[projectPath] ??
            oldExpansionStates[projectPath] ?? { isExpanded: true },
          ignoredNames: new IgnoredNames(projectPath),
          useSyncFS: this.useSyncFS,
          stats,
        });

        let root = this.createDirectoryTreeEntry(directory, null, { projectRoot: true });
        this.roots.push(root);
      }
      this.rebuildVisibleRows({ preserveScroll: false });
      return this.restoreProjectSelection(
        selectedPaths,
        focusedPath,
        retainedSelection,
        updateGeneration,
      );
    } else {
      this.rebuildVisibleRows({ preserveScroll: false });
      this.viewport.hidden = !this.specialRoots.some((section) => section.isRenderable());
      this.lastFocusedEntry = null;
      if (!this.element.querySelector("#add-projects-view")) {
        this.addProjectsView = new AddProjectsView();
        if (this.projectList) this.addProjectsView.setProjectList(this.projectList);
        if (this.recentList) this.addProjectsView.setRecentList(this.recentList);
        return this.element.appendChild(this.addProjectsView.element);
      }
    }
  }

  async restoreProjectSelection(selectedPaths, focusedPath, retainedSelection, updateGeneration) {
    if (selectedPaths.length === 0) return [];

    const restoredEntries = [];
    const restoredEntriesByPath = new Map();
    for (const selectedPath of selectedPaths) {
      const entry = await this.entryForPathAfterExpansion(selectedPath, updateGeneration);
      if (updateGeneration !== this.rootsUpdateGeneration) return [];
      if (!entry) continue;
      restoredEntriesByPath.set(selectedPath, entry);
      if (!restoredEntries.includes(entry)) restoredEntries.push(entry);
    }

    if (updateGeneration !== this.rootsUpdateGeneration) return [];

    // A click made while the filesystem was being read is newer than the
    // selection captured before the rebuild, so it must win.
    if (
      this.selectedEntries.size !== retainedSelection.size ||
      Array.from(retainedSelection).some((entry) => !this.selectedEntries.has(entry))
    ) {
      return [];
    }

    for (const entry of restoredEntries) {
      this.selectedEntries.add(entry);
      entry.syncViews();
    }

    const restoredFocus = restoredEntriesByPath.get(focusedPath);
    if (restoredFocus) {
      this.lastFocusedEntry = restoredFocus;
    } else if (!this.lastFocusedEntry || !this.selectedEntries.has(this.lastFocusedEntry)) {
      this.lastFocusedEntry = restoredEntries.at(-1) ?? null;
    }
    this.scheduleStickyHeadersUpdate();
    return restoredEntries;
  }

  async entryForPathAfterExpansion(entryPath, updateGeneration) {
    let entry = this.treeEntryForPath(entryPath);
    while (entry && !entry.isPathEqual(entryPath)) {
      if (updateGeneration !== this.rootsUpdateGeneration || entry.kind !== "directory") {
        return null;
      }

      await entry.expand();
      if (updateGeneration !== this.rootsUpdateGeneration || !this.treeEntries.has(entry)) {
        return null;
      }

      let nextEntry = entry.children.find((child) => child.isPathEqual(entryPath));
      if (!nextEntry) {
        let bestMatchLength = 0;
        for (const child of entry.children) {
          const childPath = child.getPath();
          if (child.contains(entryPath) && childPath.length > bestMatchLength) {
            nextEntry = child;
            bestMatchLength = childPath.length;
          }
        }
      }

      // If the selected item was removed by the new ignore filter, keep the
      // nearest ancestor that is still visible instead of jumping to a root.
      if (!nextEntry) return entry;
      entry = nextEntry;
    }
    return entry;
  }

  getActivePath() {
    return lumine.workspace.getCenter()?.getActivePaneItem()?.getPath?.();
  }

  selectActiveFile() {
    let activeFilePath = this.getActivePath();
    if (this.treeEntryForPath(activeFilePath)) {
      return this.selectEntryForPath(activeFilePath);
    } else {
      // If the active file is not part of the project, deselect all entries.
      return this.deselect();
    }
  }

  revealPath(filePath, options = {}) {
    if (!lumine.project.getPaths().length) {
      return Promise.resolve();
    }
    let { show, focus, center } = options;
    focus ??= lumine.config.get("tree-view.focusOnReveal");
    center ??= true;
    let promise = show || focus ? this.show(focus) : Promise.resolve();

    return promise.then(async () => {
      if (!filePath) return;
      let [rootPath, relativePath] = lumine.project.relativizePath(filePath);
      if (rootPath == null) return;

      let pathComponents = relativePath.split(path.sep);
      const expansionPromises = [];
      let revealedEntry = null;

      // Add the root folder to the path components…
      pathComponents.unshift(rootPath.substring(rootPath.lastIndexOf(path.sep) + 1));
      // …and remove it from the current path.
      let currentPath = rootPath.substring(0, rootPath.lastIndexOf(path.sep));
      for (let pathComponent of pathComponents) {
        currentPath += path.sep + pathComponent;
        let entry = this.treeEntryForPath(currentPath);
        if (!entry) break;
        // Expansion creates the next component synchronously before its promise
        // waits for the directory watcher. Keep walking now so every ancestor
        // reaches the DOM in one turn, then wait for their promises together.
        if (entry.kind === "directory") expansionPromises.push(entry.expand());
        if (currentPath === filePath || entry.isPathEqual(filePath)) {
          revealedEntry = entry;
          break;
        }
      }

      if (revealedEntry) {
        this.selectEntry(revealedEntry);
        this.scrollToEntry(revealedEntry, center);
      }
      await Promise.all(expansionPromises);
    });
  }

  revealActiveFile(options = {}) {
    return this.revealPath(this.getActivePath(), options);
  }

  // A filesystem operation completes before its watcher necessarily reports
  // the changed directory. Refresh the closest loaded directory first, then
  // use the ordinary reveal path so collapsed ancestors are expanded and the
  // resulting entry is selected and scrolled into view.
  async revealChangedPath(entryPath) {
    try {
      this.treeEntryForPath(entryPath)?.reload();
      await this.revealPath(entryPath, { show: true });
    } catch (error) {
      // The filesystem operation has already succeeded. A watcher race or a
      // closing dock must not turn it into a reported copy/move failure merely
      // because its visual follow-up could not finish.
      console.warn(`tree-view: could not reveal ${entryPath}: ${error.message}`);
    }
  }

  // Copies every selected path, one per line, in the order the rows appear on
  // screen.
  //
  // Two kinds of row contribute nothing and are skipped rather than copied as
  // a blank line: a section header stands for a path rather than owning one,
  // and a project folder relativizes to nothing. When that leaves nothing at
  // all the clipboard is left as it was rather than emptied. A path can be on
  // screen twice — a pinned row and its project copy — and is copied once.
  copySelectedEntryPath(relativePath = false) {
    const paths = new Set();
    for (const entry of this.getSelectedEntries()) {
      if (entry.specialRoot) continue;
      let pathToCopy = entry.getPath();
      if (pathToCopy && relativePath) {
        pathToCopy = lumine.project.relativize(pathToCopy);
      }
      if (pathToCopy) paths.add(pathToCopy);
    }
    if (paths.size === 0) return;
    return lumine.clipboard.write(Array.from(paths).join("\n"));
  }

  entryForPath(entryPath) {
    if (this.treeEntries) {
      return this.elementForTreeEntry(this.treeEntryForPath(entryPath)) ?? undefined;
    }

    let entries = Array.from(this.list.querySelectorAll(".entry"));
    // A symlink entry also matches its target's path via realpath, so an exact
    // path match anywhere in the list must beat an earlier realpath alias.
    let realPathMatchEntry = null;
    let bestMatchEntry = null,
      bestMatchLength = 0;
    for (let entry of entries) {
      let currentPath = entry.getPath();
      if (currentPath === entryPath) return entry;
      if (realPathMatchEntry == null && entry.isPathEqual(entryPath)) {
        realPathMatchEntry = entry;
      }
      if (entry.directory?.contains(entryPath) && currentPath.length > bestMatchLength) {
        bestMatchEntry = entry;
        bestMatchLength = currentPath.length;
      }
    }
    return realPathMatchEntry ?? bestMatchEntry;
  }

  selectEntryForPath(entryPath) {
    let entry = this.treeEntryForPath(entryPath);
    return this.selectEntry(entry);
  }

  moveDown(event) {
    event?.stopImmediatePropagation();
    if (this.roots.length === 0 && !this.selectedEntry()) {
      return this.moveEmptyViewSelection(1);
    }
    // Not `selectedEntry()`: after a shift-arrow range that is the anchor, and
    // an arrow key carries on from the end the range grew to.
    let selectedEntry = this.keyboardEntry();
    if (selectedEntry != null) {
      // If the current entry is a directory…
      if (selectedEntry.kind === "directory" && selectedEntry.isExpanded) {
        // …the next entry should be its first child.
        if (this.selectEntry(selectedEntry.children[0])) {
          this.scrollToEntry(this.selectedEntry(), false);
          return;
        }
      }
      let nextEntry = this.nextEntry(selectedEntry);
      if (nextEntry) this.selectEntry(nextEntry);
    } else {
      this.selectEntry(this.roots[0]);
    }
    return this.scrollToEntry(this.selectedEntry(), false);
  }

  moveUp(event) {
    event?.stopImmediatePropagation();
    if (this.roots.length === 0 && !this.selectedEntry()) {
      return this.moveEmptyViewSelection(-1);
    }
    let selectedEntry = this.keyboardEntry();
    if (selectedEntry != null) {
      let previousEntry = this.previousEntry(selectedEntry);
      if (previousEntry) {
        this.selectEntry(previousEntry);
      } else {
        this.selectEntry(selectedEntry.parent);
      }
    } else {
      this.selectEntry(this.visibleRows[this.visibleRows.length - 1]);
    }
    return this.scrollToEntry(this.selectedEntry(), false);
  }

  // The index of the row a keyboard move continues from: the end of the
  // selection furthest from `lastFocusedEntry`, which is the row the last
  // plain move or click landed on and the row shift-click sweeps from.
  //
  // With one row selected the two are the same row. They differ only after a
  // shift-arrow range, where the far end is the one that moved — and where the
  // next keystroke, plain or shifted, has to carry on from.
  //
  // Returns -1 when nothing is selected.
  keyboardIndex() {
    const rows = this.visibleRows;
    const anchorIndex = rows.indexOf(this.lastFocusedEntry ?? this.selectedEntry());
    if (anchorIndex === -1) return -1;

    let first = anchorIndex;
    let last = anchorIndex;
    for (const entry of this.getSelectedEntries()) {
      const index = rows.indexOf(entry);
      if (index === -1) continue;
      if (index < first) first = index;
      if (index > last) last = index;
    }
    return anchorIndex - first >= last - anchorIndex ? first : last;
  }

  keyboardEntry() {
    return this.visibleRows[this.keyboardIndex()] ?? null;
  }

  // Grows or shrinks the selection by one visible row. This is Shift+ArrowUp
  // and Shift+ArrowDown.
  //
  // The range grows from `lastFocusedEntry` and the far end moves, so
  // reversing direction shrinks the range back towards that row instead of
  // starting a new one.
  extendSelection(delta, event) {
    event?.stopImmediatePropagation();
    const rows = this.visibleRows;
    const anchorIndex = rows.indexOf(this.lastFocusedEntry ?? this.selectedEntry());
    const movingIndex = this.keyboardIndex();
    if (anchorIndex === -1 || movingIndex === -1) {
      return delta > 0 ? this.moveDown() : this.moveUp();
    }

    // Already against the top or the bottom of the tree: keep the range as it
    // is rather than collapsing it back to the anchor.
    const target = rows[movingIndex + delta];
    if (!target) return;

    this.selectRange(rows[anchorIndex], target);
    this.showMultiSelectMenuIfNecessary();
    this.scrollToEntry(target, false);
    return target;
  }

  nextEntry(entry) {
    const index = this.visibleRows.indexOf(entry);
    return index === -1 ? null : (this.visibleRows[index + 1] ?? null);
  }

  previousEntry(entry) {
    const index = this.visibleRows.indexOf(entry);
    return index <= 0 ? null : this.visibleRows[index - 1];
  }

  emptyViewControls() {
    return this.addProjectsView?.getNavigableElements() ?? [];
  }

  selectedEmptyViewControl() {
    let selected = this.addProjectsView?.element.querySelector(".btn.selected");
    if (this.emptyViewControls().includes(selected)) return selected;
    return null;
  }

  selectEmptyViewControl(control) {
    if (!control) return;
    this.deselect();
    this.addProjectsView?.clearSelection();
    this.lastFocusedEntry = null;
    control.classList.add("selected");
    this.scrollToEmptyViewControl(control);
    return control;
  }

  moveEmptyViewSelection(delta) {
    let controls = this.emptyViewControls();
    if (controls.length === 0) return;

    let selected = this.selectedEmptyViewControl();
    let index = controls.indexOf(selected);
    if (index === -1) {
      index = delta < 0 ? controls.length : -1;
    }
    return this.selectEmptyViewControl(
      controls[(index + delta + controls.length) % controls.length],
    );
  }

  activateSelectedEmptyViewControl() {
    let control =
      this.selectedEmptyViewControl() ?? this.selectEmptyViewControl(this.emptyViewControls()[0]);
    return control?.click();
  }

  scrollToEmptyViewControl(control) {
    const scrollLeft = this.scrollPosition.left;
    if (control.scrollIntoViewIfNeeded) {
      control.scrollIntoViewIfNeeded(false);
    } else {
      control.scrollIntoView({ block: "nearest" });
    }
    this.setScrollLeft(scrollLeft);
  }

  expandDirectory(isRecursive = false) {
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) return;

    let directory = selectedEntry.kind === "directory" ? selectedEntry : selectedEntry.parent;
    if (!directory) return;
    if (isRecursive === false && directory.isExpanded) {
      if (directory.directory.getEntries().length > 0) {
        // Select the first entry in the expanded folder if it exists.
        return this.moveDown();
      }
    } else {
      return directory.expand(isRecursive);
    }
  }

  collapseDirectory(isRecursive = false, allDirectories = false) {
    if (allDirectories) {
      for (let root of this.roots) root.collapse(true);
      return;
    }
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) return;

    let directory = selectedEntry.kind === "directory" ? selectedEntry : selectedEntry.parent;
    while (directory && !directory.isExpanded) directory = directory.parent;
    if (directory) {
      directory.collapse(isRecursive);
      return this.selectEntry(directory);
    }
  }

  openSelectedEntry(options = {}, expandDirectory = false) {
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) {
      if (!expandDirectory) return this.activateSelectedEmptyViewControl();
      return;
    }

    if (selectedEntry.kind === "directory") {
      if (expandDirectory) {
        return this.expandDirectory(false);
      } else {
        return selectedEntry.toggleExpansion();
      }
    } else if (selectedEntry.kind === "file") {
      if (lumine.config.get("tree-view.alwaysOpenExisting")) {
        options = { searchAllPanes: true, ...options };
      }
      return this.openAfterPromise(selectedEntry.getPath(), options);
    }
  }

  // A preview is what a single click already does: open the file where it would
  // have opened anyway, but leave the focus in the tree so the next keystroke
  // still moves the selection. Directories have nothing to preview — expanding
  // one is what `enter` is for — so they are left alone rather than toggled.
  previewSelectedEntry() {
    if (this.selectedEntry()?.kind !== "file") return;
    return this.openSelectedEntry({
      // `core.allowPendingPaneItems` decides whether the tab stays pending; the
      // keystroke only ever promises to keep the focus here.
      pending: lumine.config.get("core.allowPendingPaneItems"),
      activatePane: false,
    });
  }

  openSelectedEntrySplit(orientation, side) {
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) return;

    let pane = lumine.workspace.getCenter().getActivePane();
    if (!pane || selectedEntry.kind !== "file") return;

    if (lumine.workspace.getCenter().getActivePaneItem()) {
      let split = pane.split(orientation, side);
      return lumine.workspace.openURIInPane(selectedEntry.getPath(), split);
    } else {
      return this.openSelectedEntry({}, true);
    }
  }

  openSelectedEntryRight() {
    return this.openSelectedEntrySplit("horizontal", "after");
  }

  openSelectedEntryLeft() {
    return this.openSelectedEntrySplit("horizontal", "before");
  }

  openSelectedEntryUp() {
    return this.openSelectedEntrySplit("vertical", "before");
  }

  openSelectedEntryDown() {
    return this.openSelectedEntrySplit("vertical", "after");
  }

  openSelectedEntryInPane(index) {
    let selectedEntry = this.selectedEntry();
    if (selectedEntry == null) return;

    let pane = lumine.workspace.getCenter().getPanes()[index];
    if (pane && selectedEntry.kind === "file") {
      return lumine.workspace.open(selectedEntry.getPath(), { pane });
    }
  }

  moveSelectedEntry() {
    let oldPath;
    if (this.hasFocus()) {
      let entry = this.selectedEntry();
      // Can't move it if it's a root project directory.
      if (!entry || this.roots.includes(entry)) {
        return;
      }
      oldPath = entry.getPath();
    } else {
      oldPath = this.getActivePath();
    }
    if (!oldPath) return;
    let operationResult;
    let dialog = new MoveDialog(oldPath, {
      move: async (initialPath, newPath) => {
        try {
          operationResult = await this.fileOperationProcess.run("move", initialPath, newPath);
          return operationResult;
        } catch (error) {
          operationResult = error;
          throw error;
        }
      },
      willMove: async ({ initialPath, newPath }) => {
        const isDirectory = this.operationPathSnapshot(initialPath)?.isDirectory ?? false;
        const payload = {
          files: [{ oldPath: initialPath, newPath, isDirectory }],
        };
        if (
          this.fileOperationEvents &&
          (await this.fileOperationEvents.will("willRename", payload)) === false
        )
          return false;
        return this.emitter.emit("will-move-entry", { initialPath, newPath });
      },
      onMove: async ({ initialPath, newPath, open }) => {
        this.reportOperationCleanup(operationResult);
        this.emitter.emit("entry-moved", { initialPath, newPath });
        if (this.fileOperationEvents) {
          const isDirectory = this.operationPathSnapshot(newPath)?.isDirectory ?? false;
          await this.fileOperationEvents.did("didRename", {
            files: operationResult?.renames?.length
              ? operationResult.renames
              : [{ oldPath: initialPath, newPath, isDirectory }],
          });
          const entries = operationResult?.creates || [];
          if (entries.length) {
            await this.fileOperationEvents.did("didCreate", {
              paths: entries.map((entry) => entry.path),
              entries,
            });
          }
        }
        // After the emit, never before: `onEntryMoved` re-paths the editors
        // that followed the file, and opening ahead of that would find no item
        // at the new path and make a second editor for the same file.
        await this.revealChangedPath(newPath);
        if (open) lumine.workspace.open(newPath);
      },
      onMoveFailed: async ({ initialPath, newPath }) => {
        this.reportOperationCleanup(operationResult);
        const renames = operationResult?.renames || [];
        if (renames.length) {
          this.updateEditorsAfterPartialMove(initialPath, newPath);
          repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
          await this.fileOperationEvents?.did("didRename", { files: renames });
        }
        const entries = operationResult?.creates || [];
        if (entries.length) {
          await this.fileOperationEvents?.did("didCreate", {
            paths: entries.map((entry) => entry.path),
            entries,
          });
        }
        return this.emitter.emit("move-entry-failed", { initialPath, newPath });
      },
    });
    dialog.attach();
    // This method used to return nothing. We might as well have it return the
    // instance of `MoveDialog` so that testing is slightly easier.
    return dialog;
  }

  openSelectedEntryInNewWindow() {
    let [pathToOpen] = this.selectedPaths();
    if (pathToOpen) {
      return lumine.application.openWindow({ pathsToOpen: [pathToOpen], newWindow: true });
    }
  }

  // A file resolves to the directory holding it, so this reads the same on any
  // entry: open the folder here, with whatever editors it was last left with.
  openSelectedEntryInThisWindow() {
    let [pathToOpen] = this.selectedPaths();
    if (pathToOpen) {
      return lumine.project.setState([pathToOpen]);
    }
  }

  copySelectedEntry() {
    let oldPath;
    if (this.hasFocus()) {
      let entry = this.selectedEntry();
      if (this.roots.includes(entry)) return;
      oldPath = entry?.getPath();
    } else {
      oldPath = this.getActivePath();
    }
    if (!oldPath) return;

    let operationResult;
    let dialog = new CopyDialog(oldPath, {
      copy: async (initialPath, newPath) => {
        try {
          operationResult = await this.fileOperationProcess.run("copy", initialPath, newPath);
          return operationResult;
        } catch (error) {
          operationResult = error;
          throw error;
        }
      },
      willCopy: ({ initialPath, newPath }) =>
        this.fileOperationEvents?.will("willCreate", {
          paths: [newPath],
          entries: [
            {
              path: newPath,
              isDirectory: this.operationPathSnapshot(initialPath)?.isDirectory ?? false,
            },
          ],
        }),
      onCopy: async ({ initialPath, newPath, open }) => {
        this.emitter.emit("entry-copied", { initialPath, newPath });
        if (this.fileOperationEvents) {
          const isDirectory = this.operationPathSnapshot(newPath)?.isDirectory ?? false;
          const entries = operationResult?.creates?.length
            ? operationResult.creates
            : [{ path: newPath, isDirectory }];
          await this.fileOperationEvents.did("didCreate", {
            paths: entries.map((entry) => entry.path),
            entries,
          });
        }
        await this.revealChangedPath(newPath);
        if (open) lumine.workspace.open(newPath);
      },
      onCopyFailed: async ({ initialPath, newPath }) => {
        const entries = operationResult?.creates || [];
        if (entries.length) {
          await this.fileOperationEvents?.did("didCreate", {
            paths: entries.map((entry) => entry.path),
            entries,
          });
        }
        return this.emitter.emit("copy-entry-failed", { initialPath, newPath });
      },
    });
    return dialog.attach();
  }

  async removeSelectedEntries() {
    let activePath = this.getActivePath();
    let selectedPaths, selectedEntries;
    if (this.hasFocus()) {
      selectedPaths = this.selectedPaths();
      selectedEntries = this.getSelectedEntries();
    } else if (activePath) {
      selectedPaths = [activePath];
      selectedEntries = [this.treeEntryForPath(activePath)];
    }
    if ((selectedPaths?.length ?? 0) === 0) return;

    selectedEntries = Array.from(selectedEntries).filter(Boolean);

    // A pinned row stands for a path rather than owning it, so deleting it must
    // unpin rather than touch the disk. Hand those to the section that
    // registered them and drop them from the real delete below; the section
    // root is not a path at all, so it is only ever dropped.
    const pinnedBySection = new Map();
    for (const entry of selectedEntries) {
      if (!entry.special) continue;
      const paths = pinnedBySection.get(entry.section) ?? [];
      paths.push(entry.getPath());
      pinnedBySection.set(entry.section, paths);
    }
    for (const [section, paths] of pinnedBySection) {
      section?.config.onRemove?.(paths);
    }

    selectedEntries = selectedEntries.filter((entry) => !entry.special && !entry.specialRoot);
    selectedPaths = selectedEntries.map((e) => e.getPath());
    if (selectedPaths.length === 0) return;

    for (let root of this.roots) {
      if (selectedPaths.includes(root.getPath())) {
        await lumine.window.confirm({
          message: `The root directory '${root.directory.name}' can't be removed.`,
          buttons: ["OK"],
        });
        return;
      }
    }

    let response = 0;
    if (lumine.config.get("tree-view.confirmDelete")) {
      const confirmation = {
        message:
          selectedPaths.length > DELETE_CONFIRMATION_PATH_LIMIT
            ? `Are you sure you want to delete ${selectedPaths.length} items?`
            : `Are you sure you want to delete the selected ${selectedPaths.length > 1 ? "items" : "item"}?`,
        buttons: ["Move to Trash", "Cancel"],
      };
      if (selectedPaths.length <= DELETE_CONFIRMATION_PATH_LIMIT) {
        confirmation.detail = `You are deleting:\n${selectedPaths.join("\n")}`;
      }
      response = await lumine.window.confirm(confirmation);
    }
    if (response === 0) {
      // Move to Trash
      let failedDeletions = [];
      let deletionPromises = [];
      let deletionPlans = selectedPaths
        .map((selectedPath) => {
          const snapshot = this.operationPathSnapshot(selectedPath);
          return snapshot
            ? {
                path: selectedPath,
                isDirectory: snapshot.isDirectory,
                snapshot,
              }
            : null;
        })
        .filter(Boolean);
      deletionPlans = this.childFirstOperationPlans(deletionPlans, (plan) => plan.path);
      const existingPaths = deletionPlans.map((plan) => plan.path);
      const existingEntries = deletionPlans.map(({ path: entryPath, isDirectory }) => ({
        path: entryPath,
        isDirectory,
      }));
      if (
        this.fileOperationEvents &&
        (await this.fileOperationEvents.will("willDelete", {
          paths: existingPaths,
          entries: existingEntries,
        })) === false
      )
        return;
      if (!deletionPlans.every((plan) => this.operationPathIsCurrent(plan.path, plan.snapshot))) {
        this.reportStaleFileOperation();
        return;
      }

      // Since this goes async, all entries that correspond to paths we're
      // about to delete will soon detach frmo the tree. So we should figure
      // out ahead of time which element we're going to select when we're
      // done.
      let newSelectedEntry;
      let firstSelectedEntry = selectedEntries[0];
      if (firstSelectedEntry) {
        newSelectedEntry = firstSelectedEntry.parent;
        while (newSelectedEntry && this.selectedEntries.has(newSelectedEntry)) {
          newSelectedEntry = newSelectedEntry.parent;
        }
      }

      const deletedPaths = new Set();
      for (const plan of deletionPlans) {
        const selectedPath = plan.path;
        // Don't delete entries which no longer exist. This can happen, for
        // example, when
        //
        // * the entry is deleted outside the editor before "Move to Trash" is
        //   selected;
        // * a folder and one of its children are both selected for deletion,
        //   but the parent folder is deleted first.
        let meta = { pathToDelete: selectedPath };

        this.emitter.emit("will-delete-entry", meta);

        let trashPromise;
        try {
          trashPromise = lumine.shell.trashItem(selectedPath);
        } catch (error) {
          trashPromise = Promise.reject(error);
        }
        let promise = Promise.resolve(trashPromise)
          .then(() => {
            deletedPaths.add(selectedPath);
            try {
              this.emitter.emit("entry-deleted", meta);
            } catch (error) {
              console.error("Unable to update the tree after deleting an entry", error);
            }
          })
          .catch(() => {
            this.emitter.emit("delete-entry-failed", meta);
            failedDeletions.push(selectedPath);
          })
          .finally(() => {
            repoForPath(selectedPath)?.scheduleStatusSnapshotRefresh();
          });

        deletionPromises.push(promise);
      }

      await Promise.allSettled(deletionPromises);

      const deletedEntries = deletionPlans
        .filter((plan) => deletedPaths.has(plan.path))
        .map(({ path: entryPath, isDirectory }) => ({ path: entryPath, isDirectory }));
      if (this.fileOperationEvents && deletedEntries.length) {
        await this.fileOperationEvents.did("didDelete", {
          paths: deletedEntries.map((entry) => entry.path),
          entries: deletedEntries,
        });
      }

      if (failedDeletions.length > 0) {
        lumine.notifications.addError(this.formatTrashFailureMessage(failedDeletions), {
          description: this.formatTrashEnabledMessage(),
          detail: `${failedDeletions.join("\n")}`,
          dismissable: true,
        });
      }

      if (newSelectedEntry) {
        this.selectEntry(newSelectedEntry);
      }

      if (lumine.config.get("tree-view.squashDirectoryNames")) {
        return this.updateRoots();
      }
    }
  }

  formatTrashFailureMessage(failedDeletions) {
    let fileText = failedDeletions.length > 1 ? "files" : "file";
    return `The following ${fileText} couldn’t be moved to the trash:`;
  }

  formatTrashEnabledMessage() {
    switch (process.platform) {
      case "linux":
        return "Do you have permission to delete, and Trash is enabled on the volume where the files are stored?";
      case "darwin":
        return "Is Trash enabled on the volume where the files are stored?";
      case "win32":
        return "Is there a Recycle Bin on the drive where the files are stored?";
    }
  }

  // Public: Copy the path of the selected entry or entries.
  //
  // Write paths to the native clipboard so they can be pasted across windows.
  copySelectedEntries() {
    return this.performCopyOperation("copy");
  }

  // Public: Cut the path of the selected entry or entries.
  //
  // Write paths to the native clipboard so they can be moved across windows.
  cutSelectedEntries() {
    return this.performCopyOperation("cut");
  }

  // Clipboard events cannot carry the copied paths for the tree view: the
  // renderer may not trigger `execCommand("paste")`, and Chromium targets
  // ClipboardEvents at the focused editable element or `document.body`, never
  // at a non-editable panel. Write the payload with the async Clipboard API
  // instead, which registers the format with the operating system.
  performCopyOperation(operation) {
    const paths = this.selectedPaths();
    if (paths.length === 0) return false;

    lumine.clipboard.writeNativeData(paths.join(os.EOL), TREE_VIEW_CLIPBOARD_FORMAT, {
      version: TREE_VIEW_CLIPBOARD_VERSION,
      operation,
      paths,
    });
    return true;
  }

  // Public: Paste a copied or cut item.
  //
  // If a file is selected, the file's parent directory is used as the paste
  // destination.
  async pasteEntries() {
    const targetPath = this.getPasteTargetPath();
    if (!targetPath) return false;

    const clipboardEntry = await this.readTreeClipboardData();
    if (clipboardEntry) {
      return this.pastePaths(clipboardEntry.paths, clipboardEntry.operation, targetPath);
    }

    return lumine.pasteProviders.handlePaste({
      target: { type: "directory", path: targetPath },
    });
  }

  async readTreeClipboardData() {
    const data = await lumine.clipboard.readNativeData(TREE_VIEW_CLIPBOARD_FORMAT);
    if (
      data?.version === TREE_VIEW_CLIPBOARD_VERSION &&
      ["copy", "cut"].includes(data.operation) &&
      Array.isArray(data.paths) &&
      data.paths.length > 0 &&
      data.paths.every((entryPath) => typeof entryPath === "string" && entryPath.length > 0)
    ) {
      return data;
    }
    return null;
  }

  getPasteTargetPath() {
    const selectedEntry = this.selectedEntry();
    if (!selectedEntry) return null;
    const selectedPath = selectedEntry.getPath();
    return selectedEntry.kind === "file" ? path.dirname(selectedPath) : selectedPath;
  }

  async pastePaths(initialPaths, operation, newDirectoryPath) {
    const paths = initialPaths.filter((initialPath) => fs.existsSync(initialPath));
    let results = [];
    if (operation === "copy") {
      const reservedPaths = new Set();
      const plans = paths
        .map((initialPath) => this.planCopyEntry(initialPath, newDirectoryPath, { reservedPaths }))
        .filter(Boolean);
      results = await this.copyPlans(plans);
    } else if (operation === "cut") {
      const plans = paths
        .map((initialPath) => this.planMoveEntry(initialPath, newDirectoryPath))
        .filter(Boolean);
      results = await this.movePlans(plans);
    }
    return results.some((result) => result.success) || operation === "cut";
  }

  add(isCreatingFile) {
    let selectedEntry = this.selectedEntry() ?? this.roots[0];
    let selectedPath = selectedEntry?.getPath() ?? "";

    let dialog = new AddDialog(selectedPath, isCreatingFile, {
      willCreate: (payload) => this.fileOperationEvents?.will("willCreate", payload),
      didCreate: (payload) => this.fileOperationEvents?.did("didCreate", payload),
    });

    dialog.onDidCreateDirectory((createdPath) => {
      this.revealChangedPath(createdPath);
      if (lumine.config.get("tree-view.squashDirectoryNames")) this.updateRoots();

      this.emitter.emit("directory-created", { path: createdPath });
    });

    dialog.onDidCreateFile(async ({ path: createdPath, open }) => {
      await this.revealChangedPath(createdPath);
      if (open) lumine.workspace.open(createdPath);
      if (lumine.config.get("tree-view.squashDirectoryNames")) this.updateRoots();

      this.emitter.emit("file-created", { path: createdPath });
    });
    return dialog.attach();
  }

  removeProjectFolder(event) {
    if (this.multiSelectEnabled()) {
      for (const entry of this.getSelectedEntries()) {
        if (entry.projectRoot) {
          const path = entry.getPath?.();
          if (path) lumine.project.removePath(path);
        }
      }
      return;
    }

    // Remove the targeted project folder (generally this only happens through
    // the context menu)
    let pathToRemove = event.target.closest(".project-root > .header")?.dataset.path;

    // If an entry is selected, remove that entry's project folder
    let selectedRoot = this.selectedEntry();
    while (selectedRoot?.parent) selectedRoot = selectedRoot.parent;
    pathToRemove ??= selectedRoot?.projectRoot ? selectedRoot.getPath() : null;

    // Finally, if only one project folder exists and nothing is selected,
    // remove that folder
    if (!pathToRemove && this.roots.length === 1) {
      pathToRemove = this.roots[0].getPath?.();
    }

    if (pathToRemove) {
      lumine.project.removePath(pathToRemove);
    }
  }

  selectedEntry() {
    return this.lastFocusedEntry && this.selectedEntries.has(this.lastFocusedEntry)
      ? this.lastFocusedEntry
      : (this.getSelectedEntries()[0] ?? null);
  }

  selectEntry(entry) {
    entry = entry?.treeEntry ?? entry;
    if (!entry) return;
    this.addProjectsView?.clearSelection();
    this.lastFocusedEntry = entry;
    let selectedEntries = this.getSelectedEntries();
    if (selectedEntries.length > 1 || selectedEntries[0] !== entry) {
      this.deselect(selectedEntries);
      this.selectedEntries.add(entry);
      entry.syncViews();
    }
    this.scheduleStickyHeadersUpdate();
    return entry;
  }

  getSelectedEntries() {
    const visible = this.visibleRows.filter((entry) => this.selectedEntries.has(entry));
    for (const entry of this.selectedEntries) {
      if (!visible.includes(entry)) visible.push(entry);
    }
    return visible;
  }

  deselect(elementsToDeselect) {
    elementsToDeselect ??= this.getSelectedEntries();
    for (let selected of elementsToDeselect) {
      selected = selected?.treeEntry ?? selected;
      if (!selected) continue;
      this.selectedEntries.delete(selected);
      selected.syncViews();
    }
    this.scheduleStickyHeadersUpdate();
  }

  scrollTop(top = null) {
    if (top !== null) {
      this.setScrollTop(top);
      this.updateStickyHeaderOverlay();
      return this.scroller.scrollTop;
    } else {
      return this.scroller.scrollTop;
    }
  }

  scrollBottom(bottom = null) {
    if (bottom !== null) {
      this.setScrollTop(bottom - (this.scrollportHeight || this.scroller.clientHeight));
      this.updateStickyHeaderOverlay();
      return this.scroller.scrollTop;
    } else {
      return this.scroller.scrollTop + this.scroller.clientHeight;
    }
  }

  scrollToEntry(entry, center = true) {
    entry = entry?.treeEntry ?? entry;
    if (!entry || entry.index < 0 || this.visibleRows[entry.index] !== entry) return;

    const scrollLeft = this.scrollPosition.left;
    const viewportHeight = this.scrollportHeight || this.scroller.clientHeight;
    if (center) {
      this.setScrollTop(entry.top - Math.max(0, viewportHeight - entry.height) / 2);
    } else {
      const stickyHeight = this.collectStickyHeaderEntries().reduce(
        (height, stickyEntry) => height + stickyEntry.height,
        0,
      );
      const visibleTop = this.scrollPosition.top + stickyHeight;
      const visibleBottom = this.scrollPosition.top + viewportHeight;
      if (entry.top < visibleTop) {
        this.setScrollTop(entry.top - stickyHeight);
      } else if (entry.top + entry.height > visibleBottom) {
        this.setScrollTop(entry.top + entry.height - viewportHeight);
      }
    }
    this.updateStickyHeaderOverlay();
    this.setScrollLeft(scrollLeft);
  }

  scrollToBottom() {
    if (this.roots.length === 0 && !this.selectedEntry()) {
      let controls = this.emptyViewControls();
      return this.selectEmptyViewControl(controls[controls.length - 1]);
    }
    let lastEntry = this.visibleRows[this.visibleRows.length - 1];
    if (lastEntry) {
      this.selectEntry(lastEntry);
      this.scrollToEntry(lastEntry);
    }
  }

  scrollToTop() {
    if (this.roots.length === 0 && !this.selectedEntry()) {
      return this.selectEmptyViewControl(this.emptyViewControls()[0]);
    }
    if (this.roots[0]) {
      this.selectEntry(this.roots[0]);
    }
    this.setScrollTop(0);
    this.updateStickyHeaderOverlay();
  }

  pageUp() {
    this.setScrollTop(
      this.scrollPosition.top - (this.scrollportHeight || this.scroller.clientHeight),
    );
    this.updateStickyHeaderOverlay();
  }

  pageDown() {
    this.setScrollTop(
      this.scrollPosition.top + (this.scrollportHeight || this.scroller.clientHeight),
    );
    this.updateStickyHeaderOverlay();
  }

  operationPathSnapshot(filePath) {
    const stat = fs.lstatSyncNoException(filePath);
    if (!stat) return null;
    return {
      dev: stat.dev,
      ino: stat.ino,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      mode: stat.mode,
      size: stat.size,
      birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs,
      mtimeMs: stat.mtimeMs,
    };
  }

  operationPathIsCurrent(filePath, snapshot) {
    const current = this.operationPathSnapshot(filePath);
    if (!current || !snapshot) return current === snapshot;
    return Object.keys(snapshot).every((key) => current[key] === snapshot[key]);
  }

  operationPlansAreCurrent(plans) {
    return plans.every(
      (plan) =>
        this.operationPathIsCurrent(plan.initialPath, plan.sourceSnapshot) &&
        this.operationPathIsCurrent(plan.newPath, plan.destinationSnapshot),
    );
  }

  reportStaleFileOperation() {
    lumine.notifications.addWarning("A file operation was cancelled because its paths changed", {
      dismissable: true,
    });
  }

  reportOperationCleanup(result) {
    if (!result?.cleanupError) return;
    lumine.notifications.addWarning("A file operation left a recoverable temporary path", {
      detail: [result.cleanupError, result.cleanupPath].filter(Boolean).join("\n"),
      dismissable: true,
    });
  }

  planCopyEntry(initialPath, newDirectoryPath, { reservedPaths } = {}) {
    const sourceSnapshot = this.operationPathSnapshot(initialPath);
    if (!sourceSnapshot) return null;
    try {
      // Do not allow copying test/a/ into test/a/b/. A trailing separator
      // prevents false positives such as test/a -> test/ab.
      const realNewDirectoryPath = fs.realpathSync(newDirectoryPath) + path.sep;
      const realInitialPath = fs.realpathSync(initialPath) + path.sep;
      if (
        sourceSnapshot.isDirectory &&
        realNewDirectoryPath.startsWith(realInitialPath) &&
        !fs.isSymbolicLinkSync(initialPath)
      ) {
        lumine.notifications.addWarning("Cannot copy a folder into itself");
        return null;
      }
    } catch (error) {
      lumine.notifications.addWarning(
        `Failed to copy entry ${initialPath} to ${newDirectoryPath}`,
        { detail: error.message },
      );
      return null;
    }
    const newPath = getDuplicateCopyPath(initialPath, newDirectoryPath, {
      isDirectory: sourceSnapshot.isDirectory,
      pathExists: (candidatePath) =>
        fs.existsSync(candidatePath) || reservedPaths?.has(candidatePath),
      style: lumine.config.get("tree-view.duplicateCopyNameStyle"),
    });
    reservedPaths?.add(newPath);
    return {
      initialPath,
      newPath,
      newDirectoryPath,
      isDirectory: sourceSnapshot.isDirectory,
      sourceSnapshot,
      destinationSnapshot: this.operationPathSnapshot(newPath),
      reservedPaths,
    };
  }

  planMoveEntry(initialPath, newDirectoryPath) {
    const sourceSnapshot = this.operationPathSnapshot(initialPath);
    if (!sourceSnapshot) return null;
    try {
      // Do not allow moving test/a/ into test/a/b/. A trailing separator
      // prevents false positives such as test/a -> test/ab.
      const realNewDirectoryPath = fs.realpathSync(newDirectoryPath) + path.sep;
      const realInitialPath = fs.realpathSync(initialPath) + path.sep;
      if (
        sourceSnapshot.isDirectory &&
        realNewDirectoryPath.startsWith(realInitialPath) &&
        !fs.isSymbolicLinkSync(initialPath)
      ) {
        lumine.notifications.addWarning("Cannot move a folder into itself");
        return null;
      }
    } catch (error) {
      lumine.notifications.addWarning(
        `Failed to move entry ${initialPath} to ${newDirectoryPath}`,
        { detail: error.message },
      );
      return null;
    }
    const newPath = path.join(newDirectoryPath, path.basename(initialPath));
    return {
      initialPath,
      newPath,
      newDirectoryPath,
      isDirectory: sourceSnapshot.isDirectory,
      sourceSnapshot,
      destinationSnapshot: this.operationPathSnapshot(newPath),
    };
  }

  releaseCopyPlans(plans) {
    for (const plan of plans) plan.reservedPaths?.delete(plan.newPath);
  }

  async runCopyPlan(plan) {
    const { initialPath, newPath, newDirectoryPath, isDirectory } = plan;
    let result;
    try {
      this.emitter.emit("will-copy-entry", { initialPath, newPath });
      result = await this.fileOperationProcess.run("copy", initialPath, newPath);
    } catch (error) {
      this.emitter.emit("copy-entry-failed", { initialPath, newPath });
      lumine.notifications.addWarning(
        `Failed to copy entry ${initialPath} to ${newDirectoryPath}`,
        { detail: error.message },
      );
      return { success: false, creates: error.creates || [] };
    }
    const creates = result?.creates?.length
      ? result.creates
      : result?.cancelled
        ? []
        : [{ path: newPath, isDirectory }];
    if (result?.cancelled) {
      this.emitter.emit("copy-entry-failed", { initialPath, newPath });
      return { success: false, creates };
    }
    try {
      this.emitter.emit("entry-copied", { initialPath, newPath });
      await this.revealChangedPath(newPath);
      repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
    } catch (error) {
      console.error("Unable to update the tree after copying an entry", error);
    }
    return { success: true, creates };
  }

  async copyPlans(plans) {
    if (!plans.length) return [];
    try {
      const entries = plans.map(({ newPath, isDirectory }) => ({ path: newPath, isDirectory }));
      if (
        this.fileOperationEvents &&
        (await this.fileOperationEvents.will("willCreate", {
          paths: entries.map((entry) => entry.path),
          entries,
        })) === false
      )
        return plans.map(() => ({ success: false, creates: [] }));
      if (!this.operationPlansAreCurrent(plans)) {
        this.reportStaleFileOperation();
        return plans.map(() => ({ success: false, creates: [] }));
      }

      // Calling every async runner before awaiting any one of them preserves
      // plan order in the serialized worker queue.
      const settled = await Promise.allSettled(plans.map((plan) => this.runCopyPlan(plan)));
      const results = settled.map((entry) =>
        entry.status === "fulfilled"
          ? entry.value
          : { success: false, creates: entry.reason?.creates || [] },
      );
      const created = results.flatMap((result) => result.creates);
      if (this.fileOperationEvents && created.length) {
        await this.fileOperationEvents.did("didCreate", {
          paths: created.map((entry) => entry.path),
          entries: created,
        });
      }
      return results;
    } finally {
      this.releaseCopyPlans(plans);
    }
  }

  // Copies an entry from `initialPath` to `newDirectoryPath`. If the entry
  // already exists there, a number is appended to the basename.
  async copyEntry(initialPath, newDirectoryPath, options = {}) {
    const plan = this.planCopyEntry(initialPath, newDirectoryPath, options);
    if (!plan) return false;
    const [result] = await this.copyPlans([plan]);
    return result?.success === true;
  }

  childFirstOperationPlans(plans, pathForPlan) {
    return plans
      .map((plan, index) => ({ plan, index }))
      .sort((left, right) => {
        if (this.operationPathContains(pathForPlan(left.plan), pathForPlan(right.plan))) return 1;
        if (this.operationPathContains(pathForPlan(right.plan), pathForPlan(left.plan))) return -1;
        return left.index - right.index;
      })
      .map(({ plan }) => plan);
  }

  movePlanOrder(plans) {
    return this.childFirstOperationPlans(plans, (plan) => plan.initialPath);
  }

  normalizeOperationPath(filePath) {
    const normalized = path.resolve(filePath);
    return fs.isCaseInsensitive() ? normalized.toLowerCase() : normalized;
  }

  operationPathContains(parentPath, childPath) {
    const relative = path.relative(
      this.normalizeOperationPath(parentPath),
      this.normalizeOperationPath(childPath),
    );
    return (
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  async moveExecutionPathSnapshot(filePath) {
    let stat;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch (error) {
      if (fs.isMissingPathError(error)) return null;
      throw error;
    }
    return {
      dev: stat.dev,
      ino: stat.ino,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      mode: stat.mode,
      size: stat.size,
      birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs,
      mtimeMs: stat.mtimeMs,
    };
  }

  async moveExecutionPathsAreSame(sourcePath, destinationPath) {
    const [source, destination, realSource, realDestination] = await Promise.all([
      this.moveExecutionPathSnapshot(sourcePath),
      this.moveExecutionPathSnapshot(destinationPath),
      fs.promises.realpath(sourcePath),
      fs.promises.realpath(destinationPath),
    ]);
    return (
      source &&
      destination &&
      source.dev === destination.dev &&
      source.ino === destination.ino &&
      this.normalizeOperationPath(realSource) === this.normalizeOperationPath(realDestination)
    );
  }

  async createMoveExecutionPlan(plan, excludedSourcePaths = []) {
    const checks = [];
    const actions = [];
    const renames = [];
    const checkedPaths = new Set();
    const excluded = new Set(
      excludedSourcePaths.map((entry) => this.normalizeOperationPath(entry)),
    );
    let skipped = false;

    const addCheck = (filePath, snapshot) => {
      const key = this.normalizeOperationPath(filePath);
      if (checkedPaths.has(key)) return;
      checkedPaths.add(key);
      checks.push({ path: filePath, snapshot });
    };
    const addRename = (
      sourcePath,
      destinationPath,
      sourceSnapshot,
      destinationSnapshot,
      replace,
      sameFile = false,
    ) => {
      const rename = {
        oldPath: sourcePath,
        newPath: destinationPath,
        isDirectory: sourceSnapshot.isDirectory,
      };
      actions.push({
        type: "rename",
        sourcePath,
        destinationPath,
        sourceSnapshot,
        destinationSnapshot,
        replace,
        sameFile,
      });
      renames.push(rename);
    };
    const visit = async (sourcePath, destinationPath) => {
      if (excluded.has(this.normalizeOperationPath(sourcePath))) {
        // A nested top-level selection is run first. This plan is valid only
        // after that earlier job has removed the selected child.
        addCheck(sourcePath, null);
        return true;
      }

      const [sourceSnapshot, destinationSnapshot] = await Promise.all([
        this.moveExecutionPathSnapshot(sourcePath),
        this.moveExecutionPathSnapshot(destinationPath),
      ]);
      if (!sourceSnapshot) {
        const error = new Error(`'${sourcePath}' no longer exists.`);
        error.code = "ENOENT";
        throw error;
      }
      addCheck(sourcePath, sourceSnapshot);
      addCheck(destinationPath, destinationSnapshot);

      if (!destinationSnapshot) {
        addRename(sourcePath, destinationPath, sourceSnapshot, destinationSnapshot, false);
        return true;
      }

      if (await this.moveExecutionPathsAreSame(sourcePath, destinationPath)) {
        addRename(sourcePath, destinationPath, sourceSnapshot, destinationSnapshot, false, true);
        return true;
      }

      if (sourceSnapshot.isDirectory && destinationSnapshot.isDirectory) {
        const entries = await fs.promises.readdir(sourcePath);
        entries.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
        let fullyMoved = true;
        for (const entry of entries) {
          const childOutcome = await visit(
            path.join(sourcePath, entry),
            path.join(destinationPath, entry),
          );
          if (childOutcome?.cancelled) return childOutcome;
          if (childOutcome !== true) {
            fullyMoved = false;
          }
        }
        if (fullyMoved) {
          actions.push({ type: "remove-directory", path: sourcePath, snapshot: sourceSnapshot });
        }
        return fullyMoved;
      }

      if (sourceSnapshot.isDirectory !== destinationSnapshot.isDirectory) {
        const error = new Error(`Cannot replace '${destinationPath}' with a different entry type.`);
        error.code = sourceSnapshot.isDirectory ? "ENOTDIR" : "EISDIR";
        throw error;
      }

      const resolution = await this.resolveFileOperationConflict({
        relativePath: path.relative(plan.newDirectoryPath, destinationPath),
        sourcePath,
        destinationPath,
      });
      if (resolution === "cancel") return { cancelled: true };
      if (resolution === "skip") {
        skipped = true;
        return false;
      }
      if (resolution !== "replace") return { cancelled: true };
      addRename(sourcePath, destinationPath, sourceSnapshot, destinationSnapshot, true);
      return true;
    };

    const outcome = await visit(plan.initialPath, plan.newPath);
    if (outcome?.cancelled) return { cancelled: true };
    return {
      version: 1,
      checks,
      actions,
      renames,
      skipped,
      removesRoot: outcome === true,
    };
  }

  async prepareMovePlans(plans) {
    const uniquePlans = [];
    const sources = new Set();
    for (const plan of this.movePlanOrder(plans)) {
      const source = this.normalizeOperationPath(plan.initialPath);
      if (sources.has(source)) continue;
      sources.add(source);
      uniquePlans.push(plan);
    }

    const destinations = new Set();
    for (const plan of uniquePlans) {
      const destination = this.normalizeOperationPath(plan.newPath);
      if (destinations.has(destination)) {
        lumine.notifications.addWarning(
          `Cannot move multiple entries to the same destination '${plan.newPath}'`,
          { dismissable: true },
        );
        return null;
      }
      destinations.add(destination);
    }

    const prepared = [];
    const removedPaths = [];
    const concreteDestinations = new Set();
    for (const plan of uniquePlans) {
      const excluded = removedPaths.filter((sourcePath) =>
        this.operationPathContains(plan.initialPath, sourcePath),
      );
      let executionPlan;
      try {
        executionPlan = await this.createMoveExecutionPlan(plan, excluded);
      } catch (error) {
        lumine.notifications.addWarning(
          `Failed to prepare moving ${plan.initialPath} to ${plan.newDirectoryPath}`,
          { detail: error.message },
        );
        return null;
      }
      if (executionPlan.cancelled) return null;
      for (const rename of executionPlan.renames) {
        const destination = this.normalizeOperationPath(rename.newPath);
        if (concreteDestinations.has(destination)) {
          lumine.notifications.addWarning(
            `Cannot move multiple entries to the same destination '${rename.newPath}'`,
            { dismissable: true },
          );
          return null;
        }
        concreteDestinations.add(destination);
      }
      prepared.push({ ...plan, executionPlan });
      removedPaths.push(...executionPlan.renames.map(({ oldPath }) => oldPath));
      if (executionPlan.removesRoot) removedPaths.push(plan.initialPath);
    }
    return prepared;
  }

  async runMovePlan(plan) {
    const { initialPath, newPath, newDirectoryPath, isDirectory, executionPlan } = plan;
    let result;
    try {
      this.emitter.emit("will-move-entry", { initialPath, newPath });
      result = await this.fileOperationProcess.run("move", initialPath, newPath, { executionPlan });
      this.reportOperationCleanup(result);
    } catch (error) {
      this.reportOperationCleanup(error);
      try {
        if (error.renames?.length) {
          this.updateEditorsAfterPartialMove(initialPath, newPath);
          repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
        }
        this.emitter.emit("move-entry-failed", { initialPath, newPath });
      } catch (uiError) {
        console.error("Unable to update the tree after a partial move", uiError);
      }
      lumine.notifications.addWarning(
        `Failed to move entry ${initialPath} to ${newDirectoryPath}`,
        { detail: error.message },
      );
      return {
        success: false,
        renames: error.renames || [],
        creates: error.creates || [],
      };
    }
    const renames = result?.renames?.length
      ? result.renames
      : result?.moved
        ? executionPlan?.renames || [{ oldPath: initialPath, newPath, isDirectory }]
        : [];
    const creates = result?.creates || [];
    if (result?.cancelled || result?.skipped) {
      try {
        if (renames.length || result.partial) {
          this.updateEditorsAfterPartialMove(initialPath, newPath);
          repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
        }
        this.emitter.emit("move-entry-failed", { initialPath, newPath });
      } catch (error) {
        console.error("Unable to update the tree after a partial move", error);
      }
      return { success: !result.cancelled, renames, creates };
    }
    try {
      this.emitter.emit("entry-moved", { initialPath, newPath });
      await this.revealChangedPath(newPath);
      repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
    } catch (error) {
      console.error("Unable to update the tree after moving an entry", error);
    }
    return { success: true, renames, creates };
  }

  async movePlans(plans) {
    if (!plans.length) return [];
    const preparedPlans = await this.prepareMovePlans(plans);
    if (!preparedPlans) {
      return plans.map(() => ({ success: false, renames: [], creates: [] }));
    }
    plans = preparedPlans;
    const files = plans.flatMap(({ executionPlan }) => executionPlan.renames);
    if (
      this.fileOperationEvents &&
      (await this.fileOperationEvents.will("willRename", { files })) === false
    )
      return plans.map(() => ({ success: false, renames: [], creates: [] }));
    if (!this.operationPlansAreCurrent(plans)) {
      this.reportStaleFileOperation();
      return plans.map(() => ({ success: false, renames: [], creates: [] }));
    }

    const settled = await Promise.allSettled(plans.map((plan) => this.runMovePlan(plan)));
    const results = settled.map((entry) =>
      entry.status === "fulfilled"
        ? entry.value
        : {
            success: false,
            renames: entry.reason?.renames || [],
            creates: entry.reason?.creates || [],
          },
    );
    const renamed = results.flatMap((result) => result.renames);
    if (this.fileOperationEvents && renamed.length) {
      await this.fileOperationEvents.did("didRename", { files: renamed });
    }
    const created = results.flatMap((result) => result.creates);
    if (this.fileOperationEvents && created.length) {
      await this.fileOperationEvents.did("didCreate", {
        paths: created.map((entry) => entry.path),
        entries: created,
      });
    }
    return results;
  }

  // Moves an entry from `initialPath` to `newDirectoryPath`.
  async moveEntry(initialPath, newDirectoryPath) {
    const plan = this.planMoveEntry(initialPath, newDirectoryPath);
    if (!plan) return false;
    const [result] = await this.movePlans([plan]);
    return result?.success === true;
  }

  updateEditorsAfterPartialMove(initialPath, newPath) {
    const initialPrefix = initialPath.endsWith(path.sep) ? initialPath : initialPath + path.sep;
    for (const editor of lumine.workspace.getTextEditors()) {
      const editorPath = editor.getPath();
      if (editorPath !== initialPath && !editorPath?.startsWith(initialPrefix)) continue;

      const movedPath = newPath + editorPath.slice(initialPath.length);
      if (!fs.existsSync(editorPath) && fs.existsSync(movedPath)) {
        editor.getBuffer().setPath(movedPath);
      }
    }
    this.refreshSpecialRoots();
  }

  onMouseDown(event) {
    let entryToSelect = this.treeEntryForElement(event.target);
    if (!entryToSelect) return;
    event.stopPropagation();

    // Middle-click: select and focus, prevent auto-scroll
    if (event.button === 1) {
      event.preventDefault();
      this.selectEntry(entryToSelect);
      this.showFullMenu();
      this.focus();
      return;
    }

    let cmdKey = event.metaKey || (event.ctrlKey && process.platform !== "darwin");
    // return early if clicking on a selected entry
    if (this.selectedEntries.has(entryToSelect)) {
      // mouse right click or ctrl click as right click on darwin platforms
      if (event.button === 2 || (event.ctrlKey && process.platform === "darwin")) {
        return;
      } else {
        let shiftKey = event.shiftKey;
        this.selectOnMouseUp = { shiftKey, cmdKey };
        return;
      }
    }
    if (event.shiftKey && cmdKey) {
      // select continuous from this.lastFocusedEntry but leave others
      this.selectContinuousEntries(entryToSelect, false);
      this.showMultiSelectMenuIfNecessary();
    } else if (event.shiftKey) {
      // select continuous from this.lastFocusedEntry and deselect rest
      this.selectContinuousEntries(entryToSelect);
      this.showMultiSelectMenuIfNecessary();
      // only allow ctrl click for multi selection on non-darwin systems
    } else if (cmdKey) {
      this.selectMultipleEntries(entryToSelect);
      this.lastFocusedEntry = entryToSelect;
      this.showMultiSelectMenuIfNecessary();
    } else {
      this.selectEntry(entryToSelect);
      this.showFullMenu();
    }
  }

  onMouseUp(event) {
    if (!this.selectOnMouseUp) return;
    let { shiftKey, cmdKey } = this.selectOnMouseUp;
    this.selectOnMouseUp = null;

    let entryToSelect = this.treeEntryForElement(event.target);
    if (!entryToSelect) return;
    event.stopPropagation();

    if (shiftKey && cmdKey) {
      // select continuous from this.lastFocusedEntry but leave others
      this.selectContinuousEntries(entryToSelect, false);
      this.showMultiSelectMenuIfNecessary();
    } else if (shiftKey) {
      // select continuous from this.lastFocusedEntry and deselect rest
      this.selectContinuousEntries(entryToSelect);
      this.showMultiSelectMenuIfNecessary();
      // only allow ctrl click for multi selection on non darwin systems
    } else if (cmdKey) {
      this.deselect([entryToSelect]);
      this.lastFocusedEntry = entryToSelect;
      this.showMultiSelectMenuIfNecessary();
    } else {
      this.selectEntry(entryToSelect);
      this.showFullMenu();
    }
  }

  // Public: Return an array of paths from all selected items.
  //
  // Example:
  //
  //     this.selectedPaths()
  //     => ['selected/path/one', 'selected/path/two', 'selected/path/three']
  //
  // Returns Array of selected item paths.
  selectedPaths() {
    // A section header is a label the tree addresses with a synthetic URI, not
    // a path on disk. Every consumer of this list wants paths.
    return Array.from(this.getSelectedEntries())
      .filter((entry) => !entry.specialRoot)
      .map((entry) => entry.getPath());
  }

  // Public: Selects items within a range defined by a currently selected entry
  // and a new given entry. This is Shift+click functionality.
  selectContinuousEntries(entry, deselectOthers = true) {
    return this.selectRange(this.lastFocusedEntry ?? this.selectedEntry(), entry, {
      deselectOthers,
    });
  }

  // Public: Selects every visible row between two entries, inclusive.
  //
  // The range is taken over the rows on screen rather than over one parent's
  // children: a project root, a section header and a file are all just rows to
  // whoever is dragging a selection across them, and every consumer of the
  // selection — copy, cut, remove, the multi-select menu — takes an arbitrary
  // set of paths already. The old same-parent rule made a range starting on a
  // root select nothing at all.
  //
  // Returns an Array of the selected entries.
  selectRange(fromEntry, toEntry, { deselectOthers = true } = {}) {
    const rows = this.visibleRows;
    const fromIndex = rows.indexOf(fromEntry?.treeEntry ?? fromEntry);
    const toIndex = rows.indexOf(toEntry?.treeEntry ?? toEntry);
    if (fromIndex === -1 || toIndex === -1) return [];

    const entries = rows.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1);
    if (deselectOthers) this.deselect();
    for (const entry of entries) {
      this.selectedEntries.add(entry);
      entry.syncViews();
    }
    // The row the range grew from is the one the next keystroke sweeps from,
    // whichever end of the range it sits at.
    this.lastFocusedEntry = rows[fromIndex];
    this.scheduleStickyHeadersUpdate();
    return entries;
  }

  // Public: Selects an entry without clearing previously selected items. This
  // is Cmd+click functionality.
  selectMultipleEntries(entry) {
    entry = entry?.treeEntry ?? entry;
    if (!entry) return;
    if (this.selectedEntries.has(entry)) {
      this.selectedEntries.delete(entry);
      if (this.lastFocusedEntry === entry) {
        this.lastFocusedEntry = this.getSelectedEntries()[0] ?? null;
      }
    } else {
      this.selectedEntries.add(entry);
      this.lastFocusedEntry = entry;
    }
    entry.syncViews();
    return entry;
  }

  // Public: Toggle the `full-menu` class on the main list element to display
  // the full context menu.
  showFullMenu() {
    this.list.classList.remove("multi-select", "all-roots-selected");
    this.list.classList.add("full-menu");
    this.stickyHeaderList.classList.remove("multi-select", "all-roots-selected");
    this.stickyHeaderList.classList.add("full-menu");
    this.updateSpecialSelectMenu();
  }

  // A pinned row and a section header stand for paths rather than owning them,
  // so the menu items that write to disk have nothing to act on. Mark the
  // selection so the menu definitions can opt out of offering them.
  updateSpecialSelectMenu() {
    const selected = this.getSelectedEntries();
    const special =
      selected.length > 0 && selected.every((entry) => entry.special || entry.specialRoot);
    this.list.classList.toggle("special-select", special);
    this.stickyHeaderList.classList.toggle("special-select", special);
  }

  // Toggle the `multi-select` class on the main list element to display the
  // context menu with only the items that make sense for multi-select
  // functionality.
  showMultiSelectMenu() {
    this.list.classList.remove("full-menu");
    this.list.classList.add("multi-select");
    this.stickyHeaderList.classList.remove("full-menu");
    this.stickyHeaderList.classList.add("multi-select");
    const allRoots = Array.from(this.getSelectedEntries()).every((entry) => entry.projectRoot);
    this.list.classList.toggle("all-roots-selected", allRoots);
    this.stickyHeaderList.classList.toggle("all-roots-selected", allRoots);
    this.updateSpecialSelectMenu();
  }

  showMultiSelectMenuIfNecessary() {
    if (this.getSelectedEntries().length > 1) {
      this.showMultiSelectMenu();
    } else {
      this.showFullMenu();
    }
  }

  // Public: Check for the `multi-select` class on the main list.
  //
  // Returns Boolean
  multiSelectEnabled() {
    return this.list.classList.contains("multi-select");
  }

  onDragEnter(event) {
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (!entry) return;
    if (this.rootDragAndDrop.isDragging(event)) return;
    if (!this.isLumineTreeViewEvent(event)) return;
    event.stopPropagation();
    let count = this.dragEventCounts.get(entry);
    if (count == null) {
      count = 0;
      this.dragEventCounts.set(entry, count);
    }
    if (!(count !== 0 || this.selectedEntries.has(entry))) {
      entryElement.classList.add("drag-over", "selected");
    }
    this.dragEventCounts.set(entry, count + 1);
  }

  onDragLeave(event) {
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (!entry) return;
    if (this.rootDragAndDrop.isDragging(event)) return;
    if (!this.isLumineTreeViewEvent(event)) return;
    event.stopPropagation();
    this.dragEventCounts.set(entry, this.dragEventCounts.get(entry) - 1);
    if (this.dragEventCounts.get(entry) === 0 && entryElement.classList.contains("drag-over")) {
      entryElement.classList.remove("drag-over", "selected");
    }
  }

  // Handle entry name object dragstart event.
  onDragStart(event) {
    this.dragEventCounts = new WeakMap();
    this.selectOnMouseUp = null;
    let entry = this.treeEntryForElement(event.target);
    if (!entry) return;
    event.stopPropagation();
    if (this.rootDragAndDrop.canDragStart(event)) {
      return this.rootDragAndDrop.onDragStart(event);
    }
    let dragImage = document.createElement("ol");
    dragImage.classList.add("entries", "list-tree");
    dragImage.style.position = "absolute";
    dragImage.style.top = `0px`;
    dragImage.style.left = `0px`;
    // Ensure the cloned file name element is rendered on a separate GPU
    // layer to prevent overlapping elements located at (0px, 0px) from
    // being used as the drag image.
    dragImage.style.willChange = "transform";
    let initialPaths = [];
    const filePaths = [];
    const workspaceItems = [];
    for (let target of this.getSelectedEntries()) {
      let entryPath = target.getPath();
      let parentSelected = target.parent;
      while (parentSelected && !this.selectedEntries.has(parentSelected)) {
        parentSelected = parentSelected.parent;
      }
      if (!parentSelected) {
        initialPaths.push(entryPath);
        if (target.kind === "file") filePaths.push(entryPath);
        workspaceItems.push({ type: target.kind, path: entryPath });
        let temporaryView = null;
        let sourceElement = this.elementForTreeEntry(target);
        if (!sourceElement) {
          temporaryView = new TreeRowView(this, target.kind);
          sourceElement = temporaryView.bind(target);
        }
        let newElement = sourceElement.cloneNode(true);
        for (let [key, value] of Object.entries(getStyleObject(sourceElement))) {
          if (value === "") continue;
          newElement.style[key] = value;
        }
        newElement.style.paddingLeft = "1em";
        newElement.style.paddingRight = "1em";
        dragImage.append(newElement);
        temporaryView?.destroy();
      }
    }
    document.body.appendChild(dragImage);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setDragImage(dragImage, 0, 0);
    event.dataTransfer.setData("initialPaths", JSON.stringify(initialPaths));
    if (workspaceItems.length > 0) {
      lumine.workspaceDrops.write(event.dataTransfer, {
        kind: "tree-entries",
        effect: "copyMove",
        allowedLocations: ["center"],
        source: { windowId: lumine.window.getId() },
        items: workspaceItems,
      });
    }
    if (filePaths.length > 0) {
      event.dataTransfer.setData("text/plain", filePaths.join("\n"));
      event.dataTransfer.setData(
        "text/uri-list",
        filePaths
          .map((filePath) =>
            !path.isAbsolute(filePath) && URL.canParse(filePath)
              ? filePath
              : pathToFileURL(filePath).href,
          )
          .join("\r\n"),
      );
    }
    window.requestAnimationFrame(() => dragImage.remove());
  }

  // Handle entry dragover event; reset default dragover actions.
  onDragOver(event) {
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (!entry) return;
    if (this.rootDragAndDrop.isDragging(event)) return;
    if (!this.isLumineTreeViewEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.dragEventCounts.get(entry) > 0 && entryElement.classList.contains("selected")) {
      entryElement.classList.add("drag-over", "selected");
    }
  }

  // Handle entry drop event.
  async onDrop(event) {
    this.dragEventCounts = new WeakMap();
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (entry) {
      if (this.rootDragAndDrop.isDragging(event)) return;
      if (!this.isLumineTreeViewEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();

      // Dropping on a section header means "add these to that section"; the
      // section owns what that does. A folder pinned inside the section is a
      // real directory, so it falls through and accepts an ordinary move.
      if (entry.specialRoot) {
        let initialPaths = event.dataTransfer.getData("initialPaths");
        if (initialPaths) {
          entry.section?.config.onDrop?.(JSON.parse(initialPaths));
        }
        entryElement.classList.remove("drag-over", "selected");
        return;
      }

      let newDirectoryPath = entry.getPath?.();
      if (!newDirectoryPath) return false;

      let initialPaths = event.dataTransfer.getData("initialPaths");
      if (initialPaths) {
        // Drop event from the editor
        initialPaths = JSON.parse(initialPaths);
        if (initialPaths.includes(newDirectoryPath)) return;

        entryElement.classList.remove("drag-over", "selected");
        // Iterate backwards so that files in a dir are moved before the dir
        // itself.
        const orderedPaths = [];
        for (let j = initialPaths.length - 1; j >= 0; j -= 1) {
          // Note: This is necessary on Windows to circumvent node-pathwatcher
          // holding a lock on expanded folders and preventing them from being
          // moved or deleted.
          //
          // TODO: Investigate whether this is still needed now that we're on
          // the `watchPath` API.
          let initialPath = initialPaths[j];
          this.treeEntryForPath(initialPath)?.collapse?.();
          orderedPaths.push(initialPath);
        }
        // Mimic OS-specific conventions in which holding down a modifier key
        // means that an entry is copied rather than moved.
        const operation =
          (process.platform === "darwin" && event.metaKey) || event.ctrlKey ? "copy" : "cut";
        await this.pastePaths(orderedPaths, operation, newDirectoryPath);
      } else {
        // Drop event from OS
        entryElement.classList.remove("selected");
        const droppedPaths = [];
        for (let file of event.dataTransfer.files) {
          const droppedPath = getPathForDroppedFile(file);
          if (!droppedPath) continue;
          droppedPaths.push(droppedPath);
        }
        const operation =
          (process.platform === "darwin" && event.metaKey) || event.ctrlKey ? "copy" : "cut";
        await this.pastePaths(droppedPaths, operation, newDirectoryPath);
      }
    } else if (event.dataTransfer.files.length) {
      // A drop event from the OS that isn't targeting a specific folder in the
      // tree view. This is probably the user dragging a folder into the tree
      // view in order to add a new folder to the project.
      for (let entry of event.dataTransfer.files) {
        const droppedPath = getPathForDroppedFile(entry);
        if (droppedPath) lumine.project.addPath(droppedPath);
      }
    }
  }

  isLumineTreeViewEvent(event) {
    for (let item of event.dataTransfer.items) {
      if (item.kind === "file") return true;
    }
    return lumine.workspaceDrops.inspect(event.dataTransfer)?.kind === "tree-entries";
  }

  isVisible() {
    return this.element.offsetWidth !== 0 || this.element.offsetHeight !== 0;
  }
}

function getPathForDroppedFile(file) {
  if (typeof webUtils?.getPathForFile === "function") {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) return filePath;
    } catch {
      // Spec fakes and older call sites may still provide a path property instead.
    }
  }

  return file.path;
}

module.exports = TreeView;
