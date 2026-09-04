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

| Method                        | Payload            | Behavior                                                                                   |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `onWillCreateFiles(callback)` | `{paths, entries}` | Awaits the callback before creating paths; returning `false` cancels the operation.        |
| `onWillRenameFiles(callback)` | `{files}`          | Awaits the callback before moving paths; returning `false` cancels the operation.          |
| `onWillDeleteFiles(callback)` | `{paths, entries}` | Awaits the callback before moving paths to trash; returning `false` cancels the operation. |
| `onDidCreateFiles(callback)`  | `{paths, entries}` | Runs after paths were created successfully.                                                |
| `onDidRenameFiles(callback)`  | `{files}`          | Runs after paths were moved successfully.                                                  |
| `onDidDeleteFiles(callback)`  | `{paths, entries}` | Runs after paths were moved to trash successfully.                                         |

## Minimal example

```js
consumeTreeViewFileOperations(fileOperations) {
  return fileOperations.onWillRenameFiles(async ({ files }) => {
    await prepareReferences(files);
    return true;
  });
}
```

## Behavior

Will callbacks run in registration order. The first callback returning `false`, throwing, or rejecting cancels the complete operation before any filesystem work begins. Did callbacks run together after the complete batch settles; they receive only paths that actually changed, and a rejection is logged without turning an already completed operation into a failure.

`paths` contains absolute path strings. `entries` carries the same create/delete paths as `{path, isDirectory}` objects, while rename `files` contains `{oldPath, newPath, isDirectory}`. The richer form lets a consumer honor file-only and folder-only filters; `paths` remains the convenient form for consumers that do not care.

A copy is a create operation and a move is a rename operation. A multi-entry paste or drop produces one plural will callback, queues nothing until every listener accepts it, preserves deterministic child-before-parent move order, and produces one plural did callback after all entries settle. When a directory is merged only the child or subtree roots that physically moved are reported; cancelled, skipped, and failed entries never masquerade as completed top-level operations.

## Teardown

Dispose every returned registration when the consuming package deactivates.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. Breaking changes require a new service name.
