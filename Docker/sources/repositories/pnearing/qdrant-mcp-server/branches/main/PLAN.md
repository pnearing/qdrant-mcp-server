# MCP_SERVER_PLAN.md

## Purpose

This document defines the required modifications to `pnearing/qdrant-mcp-server` so that multiple branches of the same Git repository can be indexed simultaneously and safely.

It is written for both:

- a human developer implementing or reviewing the changes; and
- an AI coding agent working on the repository.

The existing MCP server remains responsible for:

- file discovery and ignore handling;
- Tree-sitter/AST-aware code chunking;
- secret detection;
- embedding generation;
- Qdrant collection creation and writes;
- incremental file-change detection;
- code-search tooling;
- Git-history indexing and search.

The Forgejo repository synchronizer must not duplicate those functions.

---

## Deployment Context

The MCP server is already deployed separately from all ingestion services.

Shared source root:

```text
/sources/
└── repositories/
```

`/sources` is a read/write bind mount backed by a directory on the Docker host. It is not a Docker-managed volume.

The Forgejo repository synchronizer will use the same host directory and mount it at the same path:

```text
/sources
```

The Qdrant server, MCP server, and ingestion services are separate Compose projects.

---

## Problem to Solve

The current code-index collection identity is based on the normalized Git remote URL when the supplied path is a Git repository root.

Conceptually:

```text
normalized Git remote URL
        ↓
MD5
        ↓
code_<8 hex chars>
```

That works for one checked-out branch per repository, but fails when multiple branches of the same repository are indexed.

Example:

```text
/sources/repositories/peter/project/branches/main
/sources/repositories/peter/project/branches/feature-new-filter
```

Both working trees have the same `origin` URL.

Without modification, both branches resolve to the same code collection. This creates collisions between branch indexes and their incremental snapshots.

The current chunk payload also does not identify the branch or current commit, making search results ambiguous.

---

## Required Outcome

Each repository branch must have an independent code index while retaining repository identity.

Conceptually:

```text
repository remote + branch identity
             ↓
       code collection
```

Code chunks must carry enough Git metadata to identify the exact source revision from which they were produced.

Git-history indexing should remain repository-oriented and should not be duplicated for every branch.

---

# Phase 1 — Understand and Preserve Existing Behaviour

Before modifying code, verify the current upstream version/tag used by the deployed MCP image.

Do not assume `main` matches the deployed version.

Record:

- upstream repository: `mhalder/qdrant-mcp-server`;
- deployed tag/commit;
- current embedding provider and dimensionality;
- whether hybrid search is enabled;
- current code-index collections;
- current Git-history collections;
- current snapshot directory contents.

The current implementation stores code-index snapshots under:

```text
~/.qdrant-mcp/snapshots/<collectionName>.json
```

Therefore branch-aware collection names will naturally provide separate incremental snapshots as long as collection identity is made branch-aware.

Do not change the snapshot model unless testing proves it necessary.

---

# Phase 2 — Introduce an Explicit Codebase Identity

## Goal

Stop treating a Git remote URL alone as the complete identity of a code index.

Define an internal identity structure similar to:

```ts
interface CodebaseIdentity {
    repositoryRemote?: string;
    branch?: string;
    commit?: string;
    codebasePath: string;
}
```

Recommended semantics:

- `repositoryRemote`
   - normalized `origin` remote URL when available;
   - repository identity;
- `branch`
   - checked-out local branch when on a normal branch;
   - required for branch-separated indexes;
- `commit`
   - current `HEAD` SHA;
   - metadata only, not normally part of long-term collection identity;
- `codebasePath`
   - absolute working-tree path;
   - fallback identity when Git information is unavailable.

Do not make `commit` part of the collection name. Doing so would create a new collection for every commit and defeat incremental indexing.

---

# Phase 3 — Branch Detection

For a Git working tree, obtain branch using Git itself.

Preferred command:

```bash
git symbolic-ref --quiet --short HEAD
```

or equivalent:

```bash
git branch --show-current
```

The implementation must correctly handle detached HEAD.

Recommended detached-HEAD behaviour:

1. if an explicit branch parameter was supplied to the MCP tool, use it;
2. otherwise attempt to determine an associated branch only if reliable;
3. otherwise use a deterministic detached identity such as:
    - `detached/<short-sha>`;
4. log that detached-HEAD fallback was used.

The Forgejo synchronizer is expected to maintain normal branch worktrees, so detached HEAD should be exceptional rather than normal.

---

# Phase 4 — Collection Naming

## Current Behaviour

The current implementation derives the code collection from normalized Git remote URL, falling back to absolute path.

## Required Behaviour

For Git-backed codebases with a branch:

```text
collectionIdentity =
    normalizedRemote + "\0" + branch
```

Hash that identity deterministically.

Recommended:

```text
SHA-256(normalizedRemote + "\0" + branch)
```

Example output:

```text
code_51a0ef2b4a58
```

A 12–16 hex-character prefix is preferred over the existing 8-character prefix because the system will eventually contain substantially more indexes.

Example function:

```ts
function codeCollectionName(remote: string, branch: string): string {
    const identity = `${remote}\0${branch}`;
    const hash = createHash("sha256").update(identity).digest("hex");
    return `code_${hash.substring(0, 16)}`;
}
```

### Non-Git Fallback

For non-Git directories preserve useful existing behaviour:

```text
SHA-256(absolutePath)
```

Do not require branch metadata for generic directories.

---

# Phase 5 — Backward Compatibility

Changing collection identity can orphan existing code collections.

Do not silently destroy old collections.

Implement or document one of these migration policies:

### Preferred policy

Treat branch-aware indexes as a new identity and re-index existing repositories once.

Procedure:

1. inventory current code collections;
2. deploy branch-aware MCP server;
3. run `index_codebase` against each desired branch;
4. verify search;
5. remove legacy code collections only after validation.

This is safer than attempting to rename or mutate an existing Qdrant collection in place.

### Compatibility fallback

If the MCP server is used outside this Forgejo system, retain old behaviour for non-Git directories and possibly allow a compatibility option.

Do not complicate the public tool interface unless necessary.

---

# Phase 6 — Add Git Metadata to Code Chunks

Every code point written to Qdrant should include repository and revision metadata when available.

Add payload fields comparable to:

```json
{
  "repositoryRemote": "https://forgejo.example/user/repository.git",
  "branch": "feature/new-filter",
  "commit": "04c98fe1c1...",
  "codebasePath": "/sources/repositories/user/repository/branches/feature-new-filter",
  "relativePath": "src/filter.cpp",
  "startLine": 120,
  "endLine": 174,
  "language": "cpp",
  "chunkIndex": 7,
  "name": "AdaptiveFilter::update",
  "chunkType": "function"
}
```

Existing payload fields must remain intact unless there is a strong reason to change them.

### Why `commit` belongs in each payload

`reindex_changes` updates only changed files.

Therefore, after several branch updates, different files in one branch collection may have last been embedded at different commits if their contents did not change.

There are two reasonable semantics:

#### Preferred semantic

Store the current repository `HEAD` commit associated with the indexing operation on every newly written chunk.

This tells the consumer:

> this chunk was produced while the branch was at commit X.

It does not imply that the file itself first changed at commit X.

Document that distinction.

---

# Phase 7 — Chunk IDs

The current chunk ID is derived from:

```text
filePath + startLine + endLine + content
```

Because branch indexes will live in separate collections, branch does not strictly need to be added to the point ID to avoid cross-branch collision.

However, review whether `metadata.filePath` is absolute.

If it contains the branch-specific worktree path, chunk IDs already differ by worktree.

Recommended improvement:

Generate IDs from stable repository-relative information instead:

```text
branch + relativePath + startLine + endLine + content
```

or:

```text
repositoryRemote + branch + relativePath + startLine + endLine + content
```

This avoids IDs depending on the physical host path.

Do not make this change casually if it breaks existing incremental behaviour. Add tests first.

---

# Phase 8 — Tool Interfaces

Current relevant MCP code tools include:

- `index_codebase`
- `search_code`
- `reindex_changes`
- `get_index_status`
- `clear_index`

At minimum, all operations that resolve a code collection must resolve the same branch-aware identity.

## Preferred API Design

Keep `path` as the authoritative input and derive branch from the working tree.

This allows the Forgejo synchronizer to call:

```text
index_codebase(path)
reindex_changes(path)
get_index_status(path)
clear_index(path)
```

without passing duplicate branch data.

### Optional Explicit Branch Parameter

An optional `branch` parameter may be added if required for:

- detached HEAD;
- validation;
- external clients;
- future non-standard worktrees.

If added:

- validate it against the actual checked-out branch by default;
- reject mismatches unless an explicit override is intended;
- do not let callers accidentally index branch A while labelling it branch B.

Avoid introducing an explicit parameter if path-derived branch identity is reliable enough.

---

# Phase 9 — Search Result Metadata

`search_code` currently formats results primarily with:

- file path;
- line numbers;
- language;
- score;
- content.

Extend internal `CodeSearchResult` so branch/revision metadata can be returned.

Recommended fields:

```ts
interface CodeSearchResult {
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    fileExtension: string;
    repositoryRemote?: string;
    branch?: string;
    commit?: string;
}
```

Human-readable MCP output should identify branch when known:

```text
Repository: user/project
Branch: feature/new-filter
Commit: 04c98fe1
File: src/filter.cpp:120-174
```

This prevents an AI agent from treating feature-branch code as main-branch code.

---

# Phase 10 — Index Status

`get_index_status(path)` must remain branch-specific.

Because collection identity becomes branch-specific:

```text
main worktree
    → main collection
    → main snapshot

feature worktree
    → feature collection
    → feature snapshot
```

No separate branch-state database should be introduced inside the MCP server unless necessary.

The Forgejo synchronizer owns orchestration state in SQLite.

The MCP server owns RAG indexing state.

---

# Phase 11 — Reindex Behaviour

Retain the existing incremental strategy:

```text
scan current files
      ↓
compare with previous snapshot
      ↓
added / modified / deleted
      ↓
delete old modified/deleted chunks
      ↓
chunk added/modified files
      ↓
embed
      ↓
store
      ↓
update snapshot
```

Do not replace this with Git-diff-based synchronization.

The MCP implementation already performs content-based incremental indexing and is the authoritative indexing layer.

---

# Phase 12 — Clear Index Behaviour

`clear_index(path)` must delete only the collection belonging to the branch represented by that worktree.

It must not delete indexes for sibling branches.

Example:

```text
clear_index(.../branches/feature-a)
```

must not touch:

```text
main
development
feature-b
```

After deleting the collection, only that collection's snapshot should be deleted.

Test this explicitly.

---

# Phase 13 — Git-History Indexing

Git history should remain repository-oriented, not branch-worktree-oriented.

Do not create a full Git-history index for every branch.

Rationale:

- branches share most commits;
- duplicate Git-history embeddings waste storage and embedding work;
- semantic commit search is fundamentally repository-history search.

The Forgejo synchronizer should select one canonical repository path for history indexing, preferably the repository's shared Git mirror or a canonical worktree if required by the MCP implementation.

Existing Git tools:

```text
index_git_history
index_new_commits
get_git_index_status
clear_git_index
search_git_history
```

Before implementation, inspect the Git indexer's collection naming and repository detection to verify that a bare mirror is supported.

If a bare mirror is not supported, use the default-branch worktree for Git-history operations.

Do not modify Git-history identity merely because code indexing becomes branch-aware.

---

# Phase 14 — Contextual and Federated Search

The server also supports higher-level search features.

Branch-aware code collections can affect:

- `contextual_search`;
- `federated_search`.

Audit these functions after changing code collection identity.

### Contextual Search

If contextual search takes one `path`, it should naturally operate on the branch represented by that worktree plus repository Git history.

Desired semantics:

```text
feature branch code
       +
repository-wide Git history
```

### Federated Search

Federated search should continue to accept multiple paths.

This may allow callers to search:

```text
main
feature-a
feature-b
```

as separate codebases.

Ensure results include branch metadata so duplicate/similar chunks can be distinguished.

---

# Phase 15 — Tests

Add automated tests before deployment.

## Identity Tests

- same remote + same branch → same collection;
- same remote + different branch → different collection;
- different remote + same branch → different collection;
- non-Git path → deterministic fallback;
- physical path changes but remote+branch remain the same → same collection;
- detached HEAD → deterministic documented behaviour.

## Index Tests

Create one temporary Git repository with:

```text
main
feature/test
```

Place different content in the same source file on each branch.

Verify:

1. `index_codebase(mainPath)` creates collection A;
2. `index_codebase(featurePath)` creates collection B;
3. A != B;
4. main search returns main content;
5. feature search returns feature content;
6. payload branch metadata is correct.

## Incremental Tests

Modify feature branch only.

Verify:

- `reindex_changes(featurePath)` updates feature collection;
- main collection point count/content is unchanged;
- snapshots are independent.

## Deletion Tests

Run:

```text
clear_index(featurePath)
```

Verify:

- feature collection removed;
- feature snapshot removed;
- main collection remains;
- main snapshot remains.

## Commit Metadata Tests

Update branch HEAD and change one source file.

Verify newly generated points contain the expected commit SHA.

## Search Output Tests

Verify formatted MCP results identify branch and abbreviated commit.

---

# Phase 16 — Documentation

Update upstream-facing documentation in the fork.

Document:

- code indexes are branch-aware;
- how branch identity is determined;
- behaviour for detached HEAD;
- collection naming;
- payload metadata;
- migration from legacy collections;
- shared-worktree use case;
- interaction with Git-history indexing.

Add a concrete example using:

```text
/sources/repositories/<user>/<repository>/branches/<branch-dir>
```

---

# Recommended Implementation Order

1. Add Git identity helper.
2. Add branch and HEAD detection.
3. Add branch-aware collection naming.
4. Add tests for collection identity.
5. Add repository/branch/commit payload metadata.
6. Extend `CodeSearchResult`.
7. Extend human-readable search output.
8. Verify snapshots become independent automatically.
9. Test `index_codebase`.
10. Test `reindex_changes`.
11. Test `clear_index`.
12. Audit contextual search.
13. Audit federated search.
14. Audit Git-history interaction.
15. Add migration documentation.
16. Build and deploy forked image.
17. Re-index existing repositories into branch-aware collections.
18. Remove legacy collections only after validation.

---

# Acceptance Criteria

The MCP modification is complete when all of the following are true:

- multiple branches of one remote repository can be indexed simultaneously;
- each branch resolves to a different code collection;
- the same branch resolves to the same collection regardless of its physical worktree path;
- incremental snapshots cannot collide between branches;
- `reindex_changes` modifies only the target branch;
- `clear_index` removes only the target branch;
- code points identify repository, branch, and indexing commit;
- search results identify the branch;
- existing embedding and Qdrant behaviour remains owned by the MCP server;
- Git-history data is not redundantly duplicated per branch;
- contextual/federated searches continue to operate correctly;
- automated tests cover branch isolation;
- migration from existing legacy collections is documented.

---

# Non-Goals

Do not add the following to the MCP server as part of this work:

- Forgejo API integration;
- repository discovery;
- Git cloning/fetch scheduling;
- repository blacklists;
- branch blacklists;
- SQLite orchestration state;
- webhook handling;
- Docker orchestration for ingestion services.

Those belong to the Forgejo repository synchronizer.

---

# Key Existing Source Areas

At the time this plan was written, the important upstream implementation areas include:

```text
src/code/indexer.ts
src/code/metadata.ts
src/code/sync/synchronizer.ts
src/code/sync/
src/code/types.ts
src/tools/code.ts
src/tools/schemas.ts
src/git/
```

Important observed behaviours:

- `CodeIndexer` directly invokes the configured embedding provider.
- vector dimensions come from `embeddings.getDimensions()`.
- code chunking uses `TreeSitterChunker`.
- code collection identity currently derives from Git remote URL when possible.
- incremental reindexing uses filesystem content hashes and snapshots.
- snapshots are keyed by collection name.
- payloads currently contain code metadata but not branch/revision identity.
- chunk IDs are deterministic hashes of path/location/content.
- MCP schemas currently identify codebases primarily by filesystem `path`.

Re-check upstream code before implementation if the deployed version changes.
