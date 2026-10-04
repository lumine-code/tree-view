# tree-view.file-operations

Observe and intercept file operations initiated by the tree view.

|             |                                                                             |
| ----------- | --------------------------------------------------------------------------- |
| Version     | `1.0.0`                                                                     |
| Provided by | `provideTreeViewFileOperations()`                                           |
| Consumed by | Integrations that prepare for or observe file creation, rename and deletion |
| Owner       | `tree-view` (bundled)                                                       |

## Registration

Consume `tree-view.file-operations` at `^1.0.0`. Each registration method returns a disposable.

## Contract

| Method                         | Payload                               | Behavior                                                                                   |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `supportsStagedPreparations()` | —                                     | Returns `true` when will callbacks can return prepared operations.                         |
| `onWillCreateFiles(callback)`  | `{paths, entries, signal?}`           | Awaits the callback before creating paths; returning `false` cancels the operation.        |
| `onWillRenameFiles(callback)`  | `{files, updateReferences?, signal?}` | Awaits the callback before moving paths; returning `false` cancels the operation.          |
| `onWillDeleteFiles(callback)`  | `{paths, entries, signal?}`           | Awaits the callback before moving paths to trash; returning `false` cancels the operation. |
| `onDidCreateFiles(callback)`   | `{paths, entries}`                    | Runs after paths were created successfully.                                                |
| `onDidRenameFiles(callback)`   | `{files}`                             | Runs after paths were moved successfully.                                                  |
| `onDidDeleteFiles(callback)`   | `{paths, entries}`                    | Runs after paths were moved to trash successfully.                                         |

Will callbacks accept the operation with `true` or `undefined`, veto it with `false`, or return a prepared operation without applying edits. A prepared operation declares these required methods:

| Method                     | Behavior                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit({isCurrent} = {})` | Apply the preparation only while `isCurrent()` remains true; return or resolve to `false` to stop the filesystem operation. Recheck after asynchronous work and immediately before mutating buffers. |
| `dispose()`                | Release snapshots and other preparation resources. Called after completion or when preparation is discarded; it must not apply edits.                                                                |

Optional will-payload fields:

| Field              | Type          | Behavior                                                                                                                              |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`           | `AbortSignal` | Aborts when a pending dialog is cancelled, its query changes, or the owning tree is destroyed. Stop waiting and discard late results. |
| `updateReferences` | `boolean`     | Present for rename operations; reference refactoring is requested only when it is `true`.                                             |

## Minimal example

```js
consumeTreeViewFileOperations(fileOperations) {
  return fileOperations.onWillRenameFiles(async ({ files, updateReferences, signal }) => {
    if (updateReferences !== true) return true;
    const edits = await collectReferenceEdits(files, { signal });
    return {
      commit({ isCurrent = () => true } = {}) {
        if (signal?.aborted || !isCurrent()) return false;
        applyReferenceEdits(edits);
        return true;
      },
      dispose() {
        discardReferenceEdits(edits);
      },
    };
  });
}
```

## Behavior

Will callbacks run in registration order. The first callback returning `false`, throwing, or rejecting cancels the complete operation before any filesystem work begins. Did callbacks run together after the complete batch settles; they receive only paths that actually changed, and a throw or rejection is logged without preventing other callbacks or turning an already completed operation into a failure. Confirmed disk changes are still reported when reconciling open documents or repositories fails after a move.

Prepared operations are collected until every will callback and legacy guard accepts the operation and its paths are revalidated. The dialog then closes at the operation-start boundary before preparations commit. Cancellation or query changes while preparation is pending discard it without applying edits; a late returned preparation is disposed too. Successful closure does not abort the operation's signal. Commit receives a live guard for path snapshots and the owning tree's lifetime. Preparations are disposed after success, veto, cancellation, stale paths or failure.

Check `supportsStagedPreparations?.() === true` before returning a prepared operation to an older provider. Consumers that update buffers must use preparation rather than mutate them inside a will callback, because another listener or a changed path can still cancel the operation.

`paths` contains absolute path strings. `entries` carries the same create/delete paths as `{path, isDirectory}` objects, while rename `files` contains `{oldPath, newPath, isDirectory}`. The richer form lets a consumer honor file-only and folder-only filters; `paths` remains the convenient form for consumers that do not care.

The optional `updateReferences` boolean in a will-rename payload says whether the user requested reference updates. The rename dialog's ordinary confirmation and all paste/drop moves send `false`; its separate Confirm and Update References action sends `true`. Consumers perform reference refactoring only when this flag is `true`. All guards and did-rename notifications still run for ordinary moves, and open documents follow their renamed paths.

A copy is a create operation and a move is a rename operation. A multi-entry paste or drop produces one plural will callback, queues nothing until every listener accepts it, preserves deterministic child-before-parent move order, and produces one plural did callback after all entries settle. When a directory is merged only the child or subtree roots that physically moved are reported; cancelled, skipped, and failed entries never masquerade as completed top-level operations.

## Teardown

Dispose every returned registration when the consuming package deactivates.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. Breaking changes require a new service name.
