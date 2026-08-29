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

    // The prompt renders above the input as an icon label.
    this.promptText = document.createElement("label");
    this.promptText.classList.add("icon");
    if (iconClass) {
      this.promptText.classList.add(iconClass);
    }
    this.promptText.textContent = prompt;

    this.inputDialogView = lumine.workspace.buildInputDialog({
      className: "tree-view-dialog",
      headerElement: this.promptText,
      infoMessage: info,
      // The path is seeded below, before the dialog is ever shown: the query
      // here is the value being edited, not a filter to start empty.
      preserveQuery: true,
      // Confirming leaves the path it produced closed. `confirm({open: true})`
      // is the variant that opens it, and is the only thing that differs.
      didConfirm: (newPath) => this.onConfirm(newPath, { open: false }),
      didCancel: () => this.cancel(),
    });
    this.element = this.inputDialogView.element;
    this.miniEditor = this.inputDialogView.refs.queryEditor;
    this.isDirectory = isDirectory;

    // Registered on the dialog root in the package's own namespace, which is
    // what puts them in the item-actions list with their description and
    // keystroke. The dialogs contribute nothing else, so this is the whole
    // list.
    const commands = {};
    // Both ways to confirm are named, the keyless one included: `core:confirm`
    // is chrome and the actions list leaves it out, so a dialog whose Enter and
    // Shift-Enter differ has to say so here or the choice is invisible. A
    // directory has nothing to open and makes no such choice, so it offers
    // neither and keeps the chrome alone.
    if (!isDirectory) {
      commands["tree-view:confirm"] = {
        description: "Confirm the dialog and leave the file at the resulting path closed.",
        didDispatch: () => this.confirm(),
      };
      commands["tree-view:confirm-and-open"] = {
        description: "Confirm the dialog and open the file at the resulting path.",
        didDispatch: () => this.confirm({ open: true }),
      };
    }
    commands["tree-view:select-name"] = {
      description: "Select the whole name, or the base name when it is already selected.",
      didDispatch: () => this.selectName(),
    };
    this.disposables.add(lumine.commands.add(this.element, commands));

    this.miniEditor.setText(initialPath);

    if (select) {
      // Open on the base name, so a rename types over the name and leaves the
      // directory prefix and the extension alone.
      this.selectionRange = this.nameRanges().baseName;
    } else {
      // InputDialogView selects the full query when it opens. Add dialogs keep
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
  nameRanges() {
    const text = this.miniEditor.getText();
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
    this.inputDialogView.show();
    // Show() selects the whole query; restore the requested selection or caret.
    this.miniEditor.setSelectedBufferRange(this.selectionRange);
    this.miniEditor.scrollToCursorPosition();
  }

  close() {
    this.emitter.dispose();
    this.disposables.dispose();
    this.inputDialogView.destroy();
    const center = lumine.workspace.getCenter();
    const tiledPanes = center.getTiledPanes();
    const currentPane = center.getActivePane();
    const activePane = tiledPanes.includes(currentPane) ? currentPane : tiledPanes[0];
    if (activePane && !activePane.isDestroyed()) {
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
    this.inputDialogView.update({
      status: message ? { type: "error", message } : null,
    });
  }
};
