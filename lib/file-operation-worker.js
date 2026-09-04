const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const fsp = fs.promises;
const conflictResolvers = new Map();
const cancelledJobs = new Set();
const LINK_FALLBACK_ERRORS = new Set([
  "EACCES",
  "EPERM",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
]);
let nextConflictId = 1;
const OWNED_PATH = Symbol("ownedPath");

// This module is forked directly instead of running through Task so the worker
// can pause a directory merge for a replace/skip/cancel decision from the UI.
function emit(message) {
  if (process.connected) process.send(message);
}

function serializeError(error) {
  const serialized = { message: error.message, code: error.code, stack: error.stack };
  for (const property of [
    "creates",
    "renames",
    "partial",
    "skipped",
    "cancelled",
    "cleanupError",
    "cleanupPath",
  ]) {
    if (error[property] !== undefined) serialized[property] = error[property];
  }
  return serialized;
}

function isCancelled(jobId) {
  return cancelledJobs.has(jobId);
}

function setJobCancelled(jobId, cancelled = true) {
  if (cancelled) cancelledJobs.add(jobId);
  else cancelledJobs.delete(jobId);
}

async function statNoException(filePath, method = "lstat") {
  try {
    return await fsp[method](filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(sourceStat, destinationStat) {
  return (
    sourceStat &&
    destinationStat &&
    sourceStat.dev === destinationStat.dev &&
    sourceStat.ino === destinationStat.ino
  );
}

async function pathsAreSameEntry(sourcePath, destinationPath, sourceStat, destinationStat) {
  if (!sameFile(sourceStat, destinationStat)) return false;
  const [realSource, realDestination] = await Promise.all([
    fsp.realpath(sourcePath),
    fsp.realpath(destinationPath),
  ]);
  return process.platform === "win32"
    ? realSource.toLowerCase() === realDestination.toLowerCase()
    : realSource === realDestination;
}

function snapshotFromStat(stat) {
  return stat ? { dev: stat.dev, ino: stat.ino, isDirectory: stat.isDirectory() } : null;
}

async function pathSnapshot(filePath) {
  return snapshotFromStat(await statNoException(filePath));
}

async function pathMatchesSnapshot(filePath, snapshot) {
  const current = await pathSnapshot(filePath);
  if (!current || !snapshot) return current === snapshot;
  return (
    current.dev === snapshot.dev &&
    current.ino === snapshot.ino &&
    current.isDirectory === snapshot.isDirectory
  );
}

function stalePathError(filePath) {
  const error = new Error(`'${filePath}' changed while the file operation was waiting.`);
  error.code = "ESTALE";
  return error;
}

async function requirePathSnapshot(filePath, snapshot) {
  if (!(await pathMatchesSnapshot(filePath, snapshot))) throw stalePathError(filePath);
}

function privateSiblingPath(filePath, label, jobId) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.lumine-${label}-${process.pid}-${jobId}-${crypto.randomUUID()}`,
  );
}

function createdEntry(filePath, stat) {
  return { path: filePath, isDirectory: stat.isDirectory() };
}

function renamedEntry(oldPath, newPath, stat) {
  return { oldPath, newPath, isDirectory: stat.isDirectory() };
}

function prependErrorChanges(error, { creates = [], renames = [] } = {}) {
  const existingCreates = Array.isArray(error.creates) ? error.creates : [];
  const existingRenames = Array.isArray(error.renames) ? error.renames : [];
  error.creates = [...creates, ...existingCreates];
  error.renames = [...renames, ...existingRenames];
  if (error.creates.length > 0 || error.renames.length > 0) error.partial = true;
  return error;
}

async function describeExistingPath(filePath, expectedSnapshot = null) {
  const stat = await statNoException(filePath);
  if (!stat) return [];
  if (expectedSnapshot && !(await pathMatchesSnapshot(filePath, expectedSnapshot))) return [];
  return [createdEntry(filePath, stat)];
}

async function cleanCopiedPath(destinationPath, expectedSnapshot) {
  if (!expectedSnapshot || !(await pathMatchesSnapshot(destinationPath, expectedSnapshot))) {
    return [];
  }
  try {
    await fsp.rm(destinationPath, { recursive: true, force: true });
  } catch {
    // The original copy result remains the useful outcome. Report anything the
    // cleanup could not remove so the renderer can still publish the real disk
    // changes to interested packages.
  }
  return describeExistingPath(destinationPath, expectedSnapshot);
}

function withOwnedPath(result, snapshot) {
  Object.defineProperty(result, OWNED_PATH, { value: snapshot, configurable: true });
  return result;
}

function progressReporter(jobId, phase) {
  let entries = 0;
  let lastReport = 0;
  return {
    visit() {
      entries++;
      if (entries !== 1 && entries % 128 !== 0) return true;
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        emit({ type: "progress", jobId, progress: { phase, entries } });
      }
      return true;
    },
    finish() {
      emit({ type: "progress", jobId, progress: { phase, entries } });
    },
  };
}

async function publishStagedPath(stagingPath, destinationPath) {
  const stagingStat = await fsp.lstat(stagingPath);
  const stagingSnapshot = snapshotFromStat(stagingStat);
  if (stagingStat.isDirectory()) {
    await fsp.mkdir(destinationPath, { mode: stagingStat.mode });
    const destinationSnapshot = await pathSnapshot(destinationPath);
    try {
      const entries = await fsp.readdir(stagingPath);
      entries.sort();
      for (const entry of entries) {
        await publishStagedPath(path.join(stagingPath, entry), path.join(destinationPath, entry));
      }
    } catch (error) {
      error.publishedSnapshot = destinationSnapshot;
      throw error;
    }
    try {
      await requirePathSnapshot(stagingPath, stagingSnapshot);
      await fsp.rmdir(stagingPath);
      return { snapshot: destinationSnapshot };
    } catch (error) {
      return {
        snapshot: destinationSnapshot,
        cleanupError: error.message,
        cleanupPath: stagingPath,
      };
    }
  }

  if (stagingStat.isSymbolicLink()) {
    const target = await fsp.readlink(stagingPath);
    let type;
    if (process.platform === "win32") {
      const followed = await fsp.stat(stagingPath);
      type = followed.isDirectory() ? "junction" : "file";
    }
    await fsp.symlink(target, destinationPath, type);
  } else {
    try {
      await fsp.link(stagingPath, destinationPath);
    } catch (error) {
      if (!LINK_FALLBACK_ERRORS.has(error.code)) throw error;
      await fsp.copyFile(stagingPath, destinationPath, fs.constants.COPYFILE_EXCL);
    }
  }
  const destinationSnapshot = await pathSnapshot(destinationPath);
  try {
    await requirePathSnapshot(stagingPath, stagingSnapshot);
    await fsp.unlink(stagingPath);
    return { snapshot: destinationSnapshot };
  } catch (error) {
    return { snapshot: destinationSnapshot, cleanupError: error.message, cleanupPath: stagingPath };
  }
}

async function copyPath(sourcePath, destinationPath, jobId, phase = "copying") {
  const stagingPath = privateSiblingPath(destinationPath, "copy", jobId);
  let stagingSnapshot = null;
  let stagingHandle = null;
  let published = false;
  try {
    if (isCancelled(jobId)) return { cancelled: true, creates: [] };
    const destinationStat = await statNoException(destinationPath);
    if (isCancelled(jobId)) return { cancelled: true, creates: [] };
    if (destinationStat) {
      const error = new Error(`'${destinationPath}' already exists.`);
      error.code = "EEXIST";
      throw error;
    }

    const sourceStat = await fsp.lstat(sourcePath);
    if (isCancelled(jobId)) return { cancelled: true, creates: [] };
    await requirePathSnapshot(sourcePath, snapshotFromStat(sourceStat));
    emit({
      type: "progress",
      jobId,
      progress: {
        phase,
        bytesTotal: sourceStat.isFile() ? sourceStat.size : null,
      },
    });

    const progress = progressReporter(jobId, phase);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    if (sourceStat.isFile()) {
      stagingHandle = await fsp.open(stagingPath, "wx", sourceStat.mode);
      stagingSnapshot = snapshotFromStat(await stagingHandle.stat());
      await pipeline(
        fs.createReadStream(sourcePath),
        fs.createWriteStream(stagingPath, {
          autoClose: false,
          fd: stagingHandle.fd,
        }),
      );
      await stagingHandle.chmod(sourceStat.mode);
      await stagingHandle.close();
      stagingHandle = null;
      progress.visit();
    } else if (sourceStat.isDirectory()) {
      await fsp.mkdir(stagingPath, { mode: sourceStat.mode });
      stagingSnapshot = await pathSnapshot(stagingPath);
      for (const entry of await fsp.readdir(sourcePath)) {
        await fsp.cp(path.join(sourcePath, entry), path.join(stagingPath, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter() {
            if (isCancelled(jobId)) return false;
            return progress.visit();
          },
        });
      }
    } else {
      await fsp.cp(sourcePath, stagingPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter() {
          if (isCancelled(jobId)) return false;
          return progress.visit();
        },
      });
      stagingSnapshot = await pathSnapshot(stagingPath);
    }
    if (isCancelled(jobId)) {
      const remaining = await cleanCopiedPath(stagingPath, stagingSnapshot);
      return {
        cancelled: true,
        creates: [],
        ...(remaining.length > 0 && {
          cleanupError: `Unable to remove the cancelled copy at '${stagingPath}'.`,
          cleanupPath: stagingPath,
        }),
      };
    }
    await requirePathSnapshot(stagingPath, stagingSnapshot);
    const publication = await publishStagedPath(stagingPath, destinationPath);
    published = true;
    stagingSnapshot = publication.snapshot;
    await requirePathSnapshot(destinationPath, stagingSnapshot);
    progress.finish();
    return withOwnedPath(
      {
        copied: true,
        creates: await describeExistingPath(destinationPath, stagingSnapshot),
        ...(publication.cleanupError && {
          cleanupError: publication.cleanupError,
          cleanupPath: publication.cleanupPath,
        }),
      },
      stagingSnapshot,
    );
  } catch (error) {
    try {
      await stagingHandle?.close();
    } catch {
      // Cleanup below still owns the path by identity and is the useful result.
    }
    if (error.publishedSnapshot) {
      published = true;
      stagingSnapshot = error.publishedSnapshot;
    }
    const remaining = published
      ? await describeExistingPath(destinationPath, stagingSnapshot)
      : await cleanCopiedPath(stagingPath, stagingSnapshot);
    const creates = published ? remaining : [];
    if (published) {
      if (creates.length) error.partial = true;
      if (await statNoException(stagingPath)) {
        error.cleanupError ||= `The unpublished copy remainder stays at '${stagingPath}'.`;
        error.cleanupPath ||= stagingPath;
      }
    } else if (remaining.length > 0) {
      error.partial = true;
      error.cleanupError = `Unable to remove the failed copy at '${stagingPath}'.`;
      error.cleanupPath = stagingPath;
    }
    throw prependErrorChanges(error, { creates });
  }
}

function askConflict(jobId, conflict) {
  const conflictId = nextConflictId++;
  return new Promise((resolve) => {
    conflictResolvers.set(`${jobId}:${conflictId}`, resolve);
    emit({ type: "conflict", jobId, conflictId, conflict });
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pathsHaveSameContents(leftPath, rightPath) {
  const [left, right] = await Promise.all([fsp.lstat(leftPath), fsp.lstat(rightPath)]);
  if (
    left.isDirectory() !== right.isDirectory() ||
    left.isFile() !== right.isFile() ||
    left.isSymbolicLink() !== right.isSymbolicLink()
  ) {
    return false;
  }
  if (left.isSymbolicLink()) {
    const [leftTarget, rightTarget] = await Promise.all([
      fsp.readlink(leftPath),
      fsp.readlink(rightPath),
    ]);
    return leftTarget === rightTarget;
  }
  if (left.isFile()) {
    if (left.size !== right.size) return false;
    const [leftHash, rightHash] = await Promise.all([hashFile(leftPath), hashFile(rightPath)]);
    return leftHash === rightHash;
  }
  if (!left.isDirectory()) return left.size === right.size && left.mode === right.mode;
  const [leftEntries, rightEntries] = await Promise.all([
    fsp.readdir(leftPath),
    fsp.readdir(rightPath),
  ]);
  leftEntries.sort();
  rightEntries.sort();
  if (
    leftEntries.length !== rightEntries.length ||
    leftEntries.some((entry, index) => entry !== rightEntries[index])
  ) {
    return false;
  }
  for (const entry of leftEntries) {
    if (!(await pathsHaveSameContents(path.join(leftPath, entry), path.join(rightPath, entry)))) {
      return false;
    }
  }
  return true;
}

async function restoreFrozenSource(sourcePath, tombstonePath, tombstoneSnapshot, target) {
  if (
    (await pathMatchesSnapshot(sourcePath, null)) &&
    (await pathMatchesSnapshot(tombstonePath, tombstoneSnapshot))
  ) {
    try {
      await fsp.rename(tombstonePath, sourcePath);
      return true;
    } catch (error) {
      target.cleanupError = error.message;
    }
  }
  const message = `The original source remains at '${tombstonePath}'.`;
  target.cleanupError = [target.cleanupError, message].filter(Boolean).join("\n");
  target.cleanupPath = [target.cleanupPath, tombstonePath].filter(Boolean).join("\n");
  return false;
}

async function copyThenRemove(sourcePath, destinationPath, jobId, sourceStat) {
  const sourceSnapshot = snapshotFromStat(sourceStat);
  const tombstonePath = privateSiblingPath(sourcePath, "move-source", jobId);
  const copiedPath = privateSiblingPath(destinationPath, "move-copy", jobId);
  await requirePathSnapshot(sourcePath, sourceSnapshot);
  await fsp.rename(sourcePath, tombstonePath);
  const tombstoneSnapshot = await pathSnapshot(tombstonePath);

  let result;
  try {
    result = await copyPath(tombstonePath, copiedPath, jobId, "copying-to-move");
  } catch (error) {
    await restoreFrozenSource(sourcePath, tombstonePath, tombstoneSnapshot, error);
    throw error;
  }
  if (result.cancelled || isCancelled(jobId)) {
    const cancelled = { cancelled: true, renames: [] };
    const remaining = await cleanCopiedPath(copiedPath, result[OWNED_PATH]);
    if (remaining.length) {
      cancelled.cleanupError = `The cancelled move copy remains at '${copiedPath}'.`;
      cancelled.cleanupPath = copiedPath;
    }
    await restoreFrozenSource(sourcePath, tombstonePath, tombstoneSnapshot, cancelled);
    return cancelled;
  }

  let copyMatches;
  try {
    await requirePathSnapshot(copiedPath, result[OWNED_PATH]);
    copyMatches = await pathsHaveSameContents(tombstonePath, copiedPath);
  } catch {
    copyMatches = false;
  }
  if (!copyMatches || isCancelled(jobId)) {
    const outcome = isCancelled(jobId)
      ? { cancelled: true, renames: [] }
      : stalePathError(copiedPath);
    const remaining = await cleanCopiedPath(copiedPath, result[OWNED_PATH]);
    if (remaining.length) {
      outcome.cleanupError = `The uncommitted move copy remains at '${copiedPath}'.`;
      outcome.cleanupPath = copiedPath;
    }
    await restoreFrozenSource(sourcePath, tombstonePath, tombstoneSnapshot, outcome);
    if (outcome.cancelled) return outcome;
    throw prependErrorChanges(outcome);
  }

  let finalSnapshot = null;
  try {
    await requirePathSnapshot(sourcePath, null);
    await requirePathSnapshot(destinationPath, null);
    const publication = await publishStagedPath(copiedPath, destinationPath);
    finalSnapshot = publication.snapshot;
    if (publication.cleanupError) {
      result.cleanupError = publication.cleanupError;
      result.cleanupPath = publication.cleanupPath;
    }
    await requirePathSnapshot(sourcePath, null);
    await requirePathSnapshot(destinationPath, finalSnapshot);
    const finalMatches = await pathsHaveSameContents(tombstonePath, destinationPath);
    await requirePathSnapshot(sourcePath, null);
    if (isCancelled(jobId)) {
      const cancelled = {
        cancelled: true,
        renames: [],
        creates: await describeExistingPath(destinationPath, finalSnapshot),
      };
      await restoreFrozenSource(sourcePath, tombstonePath, tombstoneSnapshot, cancelled);
      return cancelled;
    }
    if (!finalMatches) throw stalePathError(destinationPath);
  } catch (error) {
    let creates = [];
    const publishedSnapshot = finalSnapshot || error.publishedSnapshot;
    if (publishedSnapshot) {
      creates = await describeExistingPath(destinationPath, publishedSnapshot);
      error.partial = true;
    } else {
      const remaining = await cleanCopiedPath(copiedPath, result[OWNED_PATH]);
      if (remaining.length) {
        error.cleanupError = `The uncommitted move copy remains at '${copiedPath}'.`;
        error.cleanupPath = copiedPath;
      }
    }
    if (await statNoException(copiedPath)) {
      error.cleanupError = `The uncommitted move copy remains at '${copiedPath}'.`;
      error.cleanupPath = copiedPath;
    }
    await restoreFrozenSource(sourcePath, tombstonePath, tombstoneSnapshot, error);
    throw prependErrorChanges(error, { creates });
  }

  let cleanupError = result.cleanupError ?? null;
  let cleanupPath = result.cleanupPath ?? null;
  await cleanCopiedPath(tombstonePath, tombstoneSnapshot);
  if (await pathMatchesSnapshot(tombstonePath, tombstoneSnapshot)) {
    cleanupError = `Unable to remove '${tombstonePath}' after the move.`;
    cleanupPath = tombstonePath;
  }
  return {
    moved: true,
    renames: [renamedEntry(sourcePath, destinationPath, sourceStat)],
    ...(cleanupError && { cleanupError, cleanupPath }),
  };
}

async function replacePathSafely(sourcePath, destinationPath, jobId, sourceStat, destinationStat) {
  const sourceSnapshot = snapshotFromStat(sourceStat);
  const destinationSnapshot = snapshotFromStat(destinationStat);
  await requirePathSnapshot(sourcePath, sourceSnapshot);
  await requirePathSnapshot(destinationPath, destinationSnapshot);

  const backupPath = privateSiblingPath(destinationPath, "replaced", jobId);
  await fsp.rename(destinationPath, backupPath);
  const backupSnapshot = await pathSnapshot(backupPath);
  try {
    await requirePathSnapshot(sourcePath, sourceSnapshot);
    const result = await renameFresh(sourcePath, destinationPath, jobId, sourceStat, false);
    if (result.cancelled) {
      if (
        (await pathMatchesSnapshot(destinationPath, null)) &&
        (await pathMatchesSnapshot(backupPath, backupSnapshot))
      ) {
        try {
          await fsp.rename(backupPath, destinationPath);
        } catch (error) {
          result.cleanupError = error.message;
          result.cleanupPath = backupPath;
        }
      } else {
        result.cleanupError = `The original destination remains at '${backupPath}'.`;
        result.cleanupPath = backupPath;
      }
      return result;
    }
    const remaining = await cleanCopiedPath(backupPath, backupSnapshot);
    if (remaining.length) {
      result.cleanupError = `Unable to remove '${backupPath}' after replacing the destination.`;
      result.cleanupPath = backupPath;
    }
    return result;
  } catch (error) {
    // Restore the original destination only while the failed move left its path
    // vacant. Otherwise keep the backup beside it; retaining both entries is
    // safer than overwriting either one during error recovery.
    if (
      (await pathMatchesSnapshot(destinationPath, null)) &&
      (await pathMatchesSnapshot(backupPath, backupSnapshot))
    ) {
      try {
        await fsp.rename(backupPath, destinationPath);
      } catch (restoreError) {
        error.cleanupError = restoreError.message;
        error.cleanupPath = backupPath;
      }
    } else {
      error.cleanupError ||= `The original destination remains at '${backupPath}'.`;
      error.cleanupPath = backupPath;
    }
    throw error;
  }
}

async function renameFresh(
  sourcePath,
  destinationPath,
  jobId,
  sourceStat,
  allowCancellation = true,
) {
  if (allowCancellation && isCancelled(jobId)) return { cancelled: true, renames: [] };
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fsp.rename(sourcePath, destinationPath);
    return {
      moved: true,
      renames: [renamedEntry(sourcePath, destinationPath, sourceStat)],
    };
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    return copyThenRemove(sourcePath, destinationPath, jobId, sourceStat);
  }
}

async function movePath(sourcePath, destinationPath, jobId, relativeTo) {
  try {
    if (isCancelled(jobId)) return { cancelled: true, renames: [] };
    const sourceStat = await fsp.lstat(sourcePath);
    const destinationStat = await statNoException(destinationPath);

    if (!destinationStat) {
      return renameFresh(sourcePath, destinationPath, jobId, sourceStat);
    }

    if (await pathsAreSameEntry(sourcePath, destinationPath, sourceStat, destinationStat)) {
      await fsp.rename(sourcePath, destinationPath);
      return {
        moved: true,
        renames: [renamedEntry(sourcePath, destinationPath, sourceStat)],
      };
    }

    if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
      let skipped = false;
      let partiallyMoved = false;
      const renames = [];
      const creates = [];
      for (const entry of await fsp.readdir(sourcePath)) {
        let result;
        try {
          result = await movePath(
            path.join(sourcePath, entry),
            path.join(destinationPath, entry),
            jobId,
            relativeTo,
          );
        } catch (error) {
          throw prependErrorChanges(error, { creates, renames });
        }
        renames.push(...(result.renames ?? []));
        creates.push(...(result.creates ?? []));
        if (result.cancelled) {
          return {
            cancelled: true,
            partial: partiallyMoved || result.partial === true,
            renames,
            ...(creates.length > 0 && { creates }),
          };
        }
        if (result.skipped) skipped = true;
        if (result.moved || result.partial) partiallyMoved = true;
      }
      try {
        if ((await fsp.readdir(sourcePath)).length === 0) {
          await fsp.rmdir(sourcePath);
        } else {
          skipped = true;
        }
      } catch (error) {
        throw prependErrorChanges(error, { creates, renames });
      }
      if (skipped) {
        return {
          skipped: true,
          partial: true,
          renames,
          ...(creates.length > 0 && { creates }),
        };
      }
      return { moved: true, renames, ...(creates.length > 0 && { creates }) };
    }

    const resolution = await askConflict(jobId, {
      relativePath: path.relative(relativeTo, destinationPath),
      sourcePath,
      destinationPath,
    });
    if (resolution === "cancel") return { cancelled: true, renames: [] };
    if (resolution === "skip") return { skipped: true, renames: [] };

    await requirePathSnapshot(sourcePath, snapshotFromStat(sourceStat));
    await requirePathSnapshot(destinationPath, snapshotFromStat(destinationStat));

    if (sourceStat.isDirectory() !== destinationStat.isDirectory()) {
      const error = new Error(`Cannot replace '${destinationPath}' with a different entry type.`);
      error.code = sourceStat.isDirectory() ? "ENOTDIR" : "EISDIR";
      throw error;
    }

    return replacePathSafely(sourcePath, destinationPath, jobId, sourceStat, destinationStat);
  } catch (error) {
    if (Array.isArray(error.renames)) throw error;
    throw prependErrorChanges(error);
  }
}

async function validateMoveExecutionPlan(executionPlan) {
  if (
    executionPlan?.version !== 1 ||
    !Array.isArray(executionPlan.checks) ||
    !Array.isArray(executionPlan.actions)
  ) {
    const error = new Error("Invalid planned move payload.");
    error.code = "EINVAL";
    throw error;
  }
  for (const check of executionPlan.checks) {
    if (!check || typeof check.path !== "string") {
      const error = new Error("Invalid planned move path check.");
      error.code = "EINVAL";
      throw error;
    }
    await requirePathSnapshot(check.path, check.snapshot ?? null);
  }
}

async function executeMovePlan(executionPlan, jobId) {
  await validateMoveExecutionPlan(executionPlan);
  const renames = [];
  const creates = [];
  let cleanupError = null;
  let cleanupPath = null;

  for (const action of executionPlan.actions) {
    if (isCancelled(jobId)) {
      return {
        cancelled: true,
        renames,
        ...(renames.length > 0 && { partial: true }),
        ...(creates.length > 0 && { creates }),
        ...(cleanupError && { cleanupError, cleanupPath }),
      };
    }

    try {
      if (action.type === "remove-directory") {
        await requirePathSnapshot(action.path, action.snapshot);
        await fsp.rmdir(action.path);
        continue;
      }
      if (action.type !== "rename") {
        const error = new Error(`Unknown planned move action '${action.type}'.`);
        error.code = "EINVAL";
        throw error;
      }

      await requirePathSnapshot(action.sourcePath, action.sourceSnapshot);
      await requirePathSnapshot(action.destinationPath, action.destinationSnapshot ?? null);
      const sourceStat = await fsp.lstat(action.sourcePath);
      let result;
      if (action.sameFile) {
        await fsp.rename(action.sourcePath, action.destinationPath);
        result = {
          moved: true,
          renames: [renamedEntry(action.sourcePath, action.destinationPath, sourceStat)],
        };
      } else if (action.replace) {
        const destinationStat = await fsp.lstat(action.destinationPath);
        result = await replacePathSafely(
          action.sourcePath,
          action.destinationPath,
          jobId,
          sourceStat,
          destinationStat,
        );
      } else {
        result = await renameFresh(action.sourcePath, action.destinationPath, jobId, sourceStat);
      }
      renames.push(...(result.renames ?? []));
      creates.push(...(result.creates ?? []));
      cleanupError ||= result.cleanupError ?? null;
      cleanupPath ||= result.cleanupPath ?? null;
      if (result.cancelled) {
        return {
          cancelled: true,
          renames,
          ...(renames.length > 0 && { partial: true }),
          ...(creates.length > 0 && { creates }),
          ...(cleanupError && { cleanupError, cleanupPath }),
        };
      }
    } catch (error) {
      if (cleanupError && !error.cleanupError) {
        error.cleanupError = cleanupError;
        error.cleanupPath = cleanupPath;
      }
      throw prependErrorChanges(error, { creates, renames });
    }
  }

  return {
    ...(executionPlan.skipped ? { skipped: true, partial: true } : { moved: true }),
    renames,
    ...(creates.length > 0 && { creates }),
    ...(cleanupError && { cleanupError, cleanupPath }),
  };
}

async function runJob(message) {
  const { jobId, operation, sourcePath, destinationPath, executionPlan } = message;
  if (operation === "copy") {
    return copyPath(sourcePath, destinationPath, jobId);
  }
  if (operation === "move") {
    emit({ type: "progress", jobId, progress: { phase: "moving" } });
    if (executionPlan) return executeMovePlan(executionPlan, jobId);
    return movePath(sourcePath, destinationPath, jobId, path.dirname(destinationPath));
  }
  throw new Error(`Unknown file operation '${operation}'.`);
}

if (require.main === module) {
  process.on("message", async (message) => {
    if (message?.type === "cancel") {
      setJobCancelled(message.jobId);
      for (const [key, resolve] of conflictResolvers) {
        if (!key.startsWith(`${message.jobId}:`)) continue;
        conflictResolvers.delete(key);
        resolve("cancel");
      }
      return;
    }
    if (message?.type === "resolve-conflict") {
      const key = `${message.jobId}:${message.conflictId}`;
      const resolve = conflictResolvers.get(key);
      if (resolve) {
        conflictResolvers.delete(key);
        resolve(message.resolution);
      }
      return;
    }
    if (message?.type !== "run") return;

    try {
      const result = await runJob(message);
      emit({ type: "complete", jobId: message.jobId, result });
    } catch (error) {
      emit({ type: "error", jobId: message.jobId, error: serializeError(error) });
    } finally {
      setJobCancelled(message.jobId, false);
    }
  });
}

module.exports = {
  copyPath,
  movePath,
  executeMovePlan,
  replacePathSafely,
  runJob,
  setJobCancelled,
};
