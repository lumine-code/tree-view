const { CompositeDisposable, Emitter, Range, Point } = require("lumine");
const path = require("path");

module.exports = class Dialog {
  constructor(param) {
    if (param == null) {
      param = {};
    }
    const { initialPath, select, isDirectory, iconClass, prompt, info } = param;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.isDirectory = isDirectory;
    this.initialQuery = initialPath;

    // The prompt renders above the input as an icon label.
    this.promptText = document.createElement("label");
    this.promptText.classList.add("icon");
    if (iconClass) {
      this.promptText.classList.add(iconClass);
    }
    this.promptText.textContent = prompt;

    const commands = {
      "tree-view:confirm": {
        description: isDirectory
          ? "Confirm the dialog with the resulting folder path."
          : "Confirm the dialog and leave the file at the resulting path closed.",
        didDispatch: () => this.confirm(),
      },
      "tree-view:select-name": {
        description: "Select the whole name, or the base name when it is already selected.",
        didDispatch: () => this.selectName(),
      },
    };
    const actions = [
      {
        command: "tree-view:confirm",
        context: "dialog",
        primary: true,
        // Path validation may leave the prompt open. The concrete dialog
        // closes itself only once its filesystem operation can proceed.
        disposition: "stay",
        dispatch: "local",
      },
    ];
    if (!isDirectory) {
      commands["tree-view:confirm-and-open"] = {
        description: "Confirm the dialog and open the file at the resulting path.",
        didDispatch: () => this.confirm({ open: true }),
      };
      actions.push({
        command: "tree-view:confirm-and-open",
        context: "dialog",
        disposition: "stay",
        dispatch: "local",
      });
    }
    actions.push({
      command: "tree-view:select-name",
      context: "dialog",
      disposition: "stay",
      dispatch: "local",
    });

    this.inputDialogView = lumine.workspace.buildInputDialog({
      className: "tree-view-dialog",
      headerElement: this.promptText,
      infoMessage: info,
      commands,
      actions,
    });
    this.miniEditor = this.inputDialogView.getQueryEditor();
    this.disposables.add(this.inputDialogView.onDidCancel(() => this.cancel()));

    if (select) {
      // Open on the base name, so a rename types over the name and leaves the
      // directory prefix and the extension alone.
      this.selectionRange = this.nameRanges(initialPath).baseName;
    } else {
      // InputDialog selects the full query when it opens. Add dialogs keep
      // their seeded directory prefix and append the new name at its end.
      const cursor = Point(0, initialPath.length);
      this.selectionRange = Range(cursor, cursor);
    }
  }

  /**
   * The two ranges the name in the input spans: `name` is everything after the
   * last separator, `baseName` is that without its extension. The extension is
   * the last one — `dialog.spec.js` renames as `dialog.spec`, not as `dialog` —
   * and a leading dot belongs to the name, so `.gitignore` has none. Neither
   * does a directory, which makes the two ranges equal for one.
   * @returns {Object} `{name, baseName}` buffer ranges on the single line
   */
  nameRanges(text = this.miniEditor.getText()) {
    // `path.sep` alone would miss a Windows path typed with forward slashes,
    // and on POSIX both lookups are the same one.
    const start = Math.max(text.lastIndexOf(path.sep), text.lastIndexOf("/")) + 1;
    const extension = this.isDirectory ? "" : path.extname(text.slice(start));
    return {
      name: Range(Point(0, start), Point(0, text.length)),
      baseName: Range(Point(0, start), Point(0, text.length - extension.length)),
    };
  }

  /**
   * Selects the whole name, extension included, and selects the base name
   * instead when the whole name is already selected — so the key that opens
   * the dialog also cycles what the next keystroke replaces. A name with no
   * extension has one state and stays on it.
   */
  selectName() {
    const { name, baseName } = this.nameRanges();
    const selected = this.miniEditor.getSelectedBufferRange();
    this.miniEditor.setSelectedBufferRange(selected.isEqual(name) ? baseName : name);
  }

  /**
   * Confirms with whatever the editor holds, saying whether whoever acts on
   * the new path should open it. `InputDialogView#confirm` is that same text
   * handed to `onConfirm`, so this is the plain confirm with the flag added.
   * @param {Object} options - `{open}`, false by default
   */
  confirm({ open = false } = {}) {
    return this.onConfirm(this.miniEditor.getText(), { open });
  }

  attach() {
    this.inputDialogView.show({ query: this.initialQuery, selectQuery: false });
    this.miniEditor.setSelectedBufferRange(this.selectionRange);
    this.miniEditor.scrollToCursorPosition();
  }

  close() {
    this.emitter.dispose();
    this.disposables.dispose();
    this.inputDialogView.destroy();
    const activePane = lumine.workspace.getCenter().getActivePane();
    if (!activePane.isDestroyed()) {
      return activePane.activate();
    }
  }

  cancel() {
    this.close();
    document.querySelector(".tree-view")?.focus();
  }

  // The dialog clears the status itself on the next keystroke, so this only
  // ever has to raise one. It used to also flash an `error` class on the root
  // for 300ms, which nothing in this package or any theme ever styled.
  showError(message) {
    this.inputDialogView.setStatus(message ? { type: "error", message } : null);
  }
};
