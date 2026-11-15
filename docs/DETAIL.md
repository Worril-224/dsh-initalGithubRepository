# Git auto-commit

Commit and push a session's code changes after every completed turn, with a commit message written by the model from that turn's own changes and an optional AI-maintained README.

## What it adds

- **Session row button and menu entry** — every Session row in the left sidebar gets a small git button on hover, and the same action appears in the Session's `…` menu (useful on touch devices and when the sidebar is narrow). It opens the per-session settings: enable auto-commit, repository, a **branch dropdown built from the repository's actual branches**, the **Also update README with AI** switch, and a **Version rollback** section. The feature is **off by default**; nothing is committed until the session is configured and enabled. An enabled Session also shows a small branch marker at rest in the row's trailing area, and a warning-colored marker while a commit is waiting for confirmation.
- **Workspace settings in the workspace `…` menu** — a workspace's default repository, branch, README-update switch, and **merge / rebase branch operations** are configured from its own row menu (`Git auto-commit…`). This DSH version exposes no workspace-row hover action seat, so the workspace `…` menu is the additive placement. A workspace default is a **template for sessions created afterwards**; editing it does not change existing sessions. It is off by default.
- **Git settings entry at the top of the sidebar** — a button beside **New session** opens the global settings:
  - default commit user name and email;
  - a private GitHub token (used for HTTPS pushes, stored in the DSH credential store, never written to the repository);
  - whether to ask for confirmation before each commit;
  - the GitHub account detected from the token and the default GitHub repository prefix;
  - whether to ask to create a repository that GitHub cannot find;
  - the AI provider and model used for commit messages, README updates, and repository descriptions.
- **Token-derived GitHub prefix** — when a token is saved, the plugin calls GitHub's `GET /user`, stores the login, and sets the default prefix to `https://github.com/<login>/`. The prefix is editable. Repository fields accept:
  - a short name (`my-repo`) — appended to the prefix;
  - `owner/repo` — resolved against `github.com`;
  - a full URL (`https://github.com/owner/repo.git`) — stored as-is;
  - a local path — use an absolute path or start with `/`, `./`, `../`, or `~/`.
- **Missing-repository creation** — when a session or workspace is enabled with a GitHub repository that cannot be found, and the "ask to create" setting is on, a GitHub-style form opens with owner, name, description, visibility (private/public), README initialization, `.gitignore` template, license template, Issues/Projects/Wiki switches, and homepage. Creating the repository writes its clone URL back into the session or workspace configuration. "Do not create; save anyway" stores the name for a repository you create elsewhere. A short repository name needs an account prefix (detected from the token or set manually); otherwise use `owner/repo` or a full URL.
- **AI project description** — the create-repository form has an **AI generate** button next to Description. It reads the project's metadata (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and similar), README, file names, and a few source samples, then asks the AI configured in Git settings for a one-to-two-sentence GitHub description (at most 350 characters). The result fills the editable description field; the user can change it before creating the repository.
- **Independent confirmation window** — when confirmation is on, a modal opens after a turn. It shows the repository, branch, and the **uncommitted workspace changes**, and a freely editable commit message. Choose **Commit and push** to use that message, or **Skip this commit** to leave the working tree untouched. With **提交后隐藏窗口，后台完成** enabled (the default, remembered in the browser), confirming hides the window immediately and the commit/push continues in the background, so you can keep working in DSH; the result arrives as a notice. While a commit is running, the footer also shows **隐藏窗口**, and the window's close button or Escape hides it without cancelling. The window traps focus, focuses the message field, and does not dismiss on Escape before a decision is made; form dialogs keep unsaved edits when the backdrop or Escape is used.
- **AI commit messages** — the message is generated from the turn's user request, the agent's summary, the tool-touched files, and the git diff. It follows Conventional Commits (`feat(scope): subject`, then an optional body). If the model is unavailable, a deterministic `chore:` fallback is used.
- **AI README updates** — independently switchable per session and per workspace (the workspace switch is a template for new sessions). Before committing, the plugin asks the same model that wrote the commit message to update the project README from the current README, commit message, changed files, and diff. It preserves the existing structure and language, returns the complete document, or answers `NO_CHANGE` when nothing needs updating. A root README (`README.md`, `README`, `.rst`, or similar) is updated; `README.md` is created if none exists. The updated README is committed together with the code. A model failure or an unhelpful/short rewrite is reported but never blocks the code commit.
- **Notices** — successful pushes, local-only commits, failures, and README update results are shown as a short notice.
- **Version sync and manual retry** — the Session dialog compares the local `HEAD` with the configured remote branch and shows whether they match, whether the working tree is dirty, and any last automatic failure. When they differ (or after a failure), a **Manual commit / retry** button runs the same commit flow as auto-commit: AI message, optional README update, confirmation window, commit/push, and remote reconciliation. If the tree is clean but local commits are unpushed, it retries the push directly instead of creating an empty commit.

## How a commit runs

1. A turn ends with the `completed` reason.
2. The plugin resolves the session repository (session override first, then the workspace default copied when the session was created) and expands a short name with the current GitHub prefix.
3. It ensures the session workspace is a git repository and asks the model for a commit message.
4. When the configured branch is a **new branch with a base**, the plugin fetches the base if needed, creates the branch from that commit, and checks it out (uncommitted changes are preserved when git can do so). A new branch is created at the first commit; a remote branch with the same name is rejected so an existing branch is not overwritten.
5. If the session (or its workspace template) enables README updates, the same model updates the root README before anything is staged.
6. It stages all changes (`git add -A`) and commits with the configured name/email, then pushes `HEAD` to the configured branch through the repository URL or local path. The remote is also registered locally as `dsh-auto-commit`; an existing `origin` is never overwritten.
7. If pushing fails, the commit stays local and the notice shows the git error.
8. If the remote rejects the push because it has newer history (`fetch first` / non-fast-forward), the plugin fetches the configured branch, merges it with `--allow-unrelated-histories`, and retries the push once. A merge conflict aborts the merge and keeps the local commit, with a message asking for manual resolution.

## Branches, new branches, merge and rebase

The branch field in Session and workspace settings is a dropdown, not free text. Opening the settings reads **local Git data first** (local branches and the `refs/remotes/dsh-auto-commit/*` refs) and lists the current and default branches first. It then checks the configured remote with `git ls-remote`; only when the remote heads differ from those local tracking refs does it fetch and update them. If they match, the local refs are used unchanged. The **＋ Create a new branch…** entry at the end opens a small dialog with a **Based on branch** selector and a new-branch name field. The branch is created and checked out by the next commit from the selected base; a remote branch with the same name is rejected so an existing branch is never overwritten. The base may be a remote-only branch; it is fetched on demand. If the branch list cannot be fetched, the dialog shows the error and a retry action, and the current configured value can still be saved.

Selecting an existing branch changes the **push target** for subsequent commits. The plugin does not switch the local checkout for an existing branch; it pushes the current `HEAD` to that branch and uses the normal remote-merge recovery if the remote branch has diverged. Selecting a new branch does switch the checkout, because the commit must be based on the chosen base.

The workspace dialog also contains **Branch operations**:

- **Merge into current branch** — runs `git merge --no-edit` with the selected source branch (or its fetched commit) on the branch currently checked out in the workspace. Conflicts abort the merge and report the unmerged files.
- **Rebase current branch** — runs `git rebase` onto the selected branch. Conflicts abort the rebase and leave the branch as it was.
- Both operations require a clean working tree. Each has an optional **Push to the configured repository when done** checkbox. Push uses a normal (non-force) push; a rebase that rewrites already-pushed history may therefore report a push error with a force-push hint, while the local rebase result is kept.
- The operation result (including the new commit and any push warning) is shown inline; the branch list refreshes afterwards.

## Version rollback

The Session dialog has a **Version rollback…** section. It opens a commit tree assembled from **local Git refs first**; the Host then compares the local remote-tracking refs with `git ls-remote` and fetches only if the remote has moved. The tree shows graph connector rows plus clickable commit rows with the short hash, subject, decorations (branches/HEAD), author, and date; the dialog reports whether local data was used or remote refs were refreshed. The tree covers up to the 1,000 most recent commits and is refreshed on demand.

Selecting a commit fills an editable rollback message. **Roll back to this version** makes the project content match the selected commit's tree, then creates a **new commit on the current branch whose parent is the current HEAD**. The selected version and all later commits remain in history, so the old state can still be inspected. A later file that was tracked is removed from the tree; the working tree is required to be clean before the operation. The rollback commit can be pushed with the normal branch target; a push failure leaves the commit local and reports the error. The graph is reloaded after a successful rollback so the new commit appears at the top.

## Version sync and manual retry

The Session dialog has a **Version sync** section. Opening it (and after each new commit result) reads the local `HEAD`, the working-tree status, and the remote head for the configured branch using a local-first, read-only check: the local state is read first, then a short `git ls-remote` comparison obtains the cloud head. The sync indicator does not fetch; branch and graph views perform that update when needed. It shows the local/cloud hashes, branch, ahead/behind counts when available, uncommitted-file count, and the latest failed automatic result for the session.

A **Manual commit / retry** button is offered when the versions differ, the working tree is dirty, the repository is not initialized, the remote cannot be checked, or the latest automatic result failed. The button is hidden while a commit proposal is already pending, and it is disabled while the settings form has unsaved changes (the manual flow uses the saved repository/branch configuration).

The manual flow is intentionally the same as the automatic one:

- dirty working tree → inspect changes, generate an AI commit message, optionally update the README, show the normal confirmation window (when confirmation is on), then commit and push with the same branch-creation and remote-reconciliation logic;
- clean working tree with local commits ahead of the remote → retry the push directly. If the push is rejected because the remote diverged, the same merge-and-retry recovery runs; a conflict leaves the local commits intact and reports the error;
- a clean, in-sync tree shows no retry button.

The confirmation window for a manual proposal is labeled **Confirm manual commit** and says it is a retry. The result is recorded like an automatic commit, so the normal success/failure notice and the next sync refresh see it.

## Background commits

After you confirm, the confirmation window can disappear while the Host keeps committing and pushing. The Session's sidebar marker reads **Committing in background** until the operation settles; success, local-only commits, and failures appear as the usual short notices. If the browser request itself fails before the Host records a result, the window reopens with the error so the proposal is not lost. The **hide after committing** choice is stored in the browser and defaults to on.

## AI model, README updates, and project descriptions

Choose the provider and model in **Git settings → AI model**. When a model is selected there, it is used for **commit messages, README updates, and new-repository descriptions**. When it is left empty, commit messages and README updates use the session's active model (or the agent default model as a fallback), and repository descriptions use the agent default model.

The README-update switch is available in every Session dialog and in each workspace's `Git auto-commit…` dialog. The workspace switch is copied to sessions created afterwards, like the workspace repository; existing sessions are not changed. A session switch takes effect only when that session has auto-commit enabled and a repository.

Before staging, the Host reads the root README (`README.md`, `README`, `readme.md`, `README.markdown`, or `README.rst`), the commit message, the turn's request and summary, the changed-file list, the diff excerpt, and project metadata. It asks the model for a complete updated README (or `NO_CHANGE`). The prompt requires preserving the README's language, structure, links, commands, and tone; only affected sections should change. A missing README is created as `README.md`. The update is written atomically and included in the same commit.

Safety behavior: a README longer than 12,000 characters is left untouched; a long README replaced by a much shorter response is rejected; an empty response, a model error, or a missing AI route is reported as a warning while the code commit continues. The warning and the updated file name appear in the result notice.

The create-repository form's **AI generate** button uses the same setting. It sends the session or workspace id so the Host reads the correct project directory. The selector loads the providers and models advertised by the running Harness. A model failure leaves the description unchanged and shows the error; the user can retry or type a description manually.

## GitHub identity and missing repositories

- The token is read from the DSH credential store and sent to GitHub only for `/user`, repo existence checks, and repo creation. Git pushes use an HTTP `Authorization` header, not a token-bearing URL.
- Existence checks run when a session or workspace is **enabled** with a GitHub repository, the "ask to create" setting is on, and a token is configured. Only `github.com` URLs are checked; an enterprise or other host is saved without an API check.
- A definitive `404` opens the create form. A `401`/`403`/network failure saves the configuration with a warning instead of blocking it.
- The token needs permission to create repositories on the selected owner: a classic token with `repo`, or a fine-grained token with repository creation/administration rights. For an organization owner, the token account must also be allowed to create repositories there.
- README initialization is **off by default**: an empty repository receives its first commit from the initial push. Enabling it creates a separate commit and can make the first push non-fast-forward; the form warns about this.

## Workspace defaults and new sessions

A workspace default is a **template**, not a live link:

- a session created after the workspace default was saved receives a copy of it, including the README-update switch;
- a workspace config may contain only the README switch, with auto-commit off and no repository; it is kept so new sessions can inherit the switch;
- changing the workspace default later does **not** change any existing session;
- sessions that existed before the workspace default was saved stay off unless you configure them individually;
- session settings always win.

## Configuration and storage

- Global, per-session, and per-workspace settings live in `$DSH_HOME/git-auto-commit/state.json`. Session and workspace records include the selected branch, its optional new-branch base, and the README-update switch.
- The GitHub token lives in the DSH credential store under the `dsh-git-auto-commit/github-token` record. It is only read when pushing, checking a repository, creating a repository, or detecting the account.
- The workspace is initialized as a git repository on first use if it is not already one. Existing parent repositories are not reused: the repository is created at the session working directory.

## Limitations

- Pushing needs credentials with write access. A GitHub token without `repo`/`contents: write` permission fails at the push step; the commit is kept locally.
- A local path used as a repository is treated as a remote: a missing path is initialized as a bare repository. Pushing into a non-bare checkout with a different branch checked out can be refused by git.
- The confirmation window is served by the Host and must be open in a connected Web session; if no page is connected, the proposal waits in memory for up to 30 minutes.
- Only one commit runs per session at a time; turns that end while a commit is in progress are queued.
- This plugin commits the whole working tree, not only the files touched in the turn, so uncommitted changes from earlier turns are included in the next commit. The confirmation window labels this explicitly.
- The GitHub API calls require network access to `api.github.com`; when it is unavailable, token detection and repository creation fail, and repository checks degrade to a save-with-warning.
- AI descriptions need a reachable model route. If the selected provider/model is unavailable, the generate button shows the error; the manual description field always remains usable. The AI prompt includes project metadata, README text, and a few source samples, so avoid putting secrets in files that should not be sent to the model.
- README updates rewrite the complete root README; nested READMEs and documentation sites are not touched. The model receives the README, commit message, changed-file list, and a diff excerpt, so the same caution about secrets applies.
- A README longer than 12,000 characters is skipped to avoid a partial rewrite. A rewrite that would shrink a long README below roughly 40% of its original length is rejected and the original is kept. Both cases are reported in the notice, and the code commit still proceeds.
- The README update runs after you confirm (or automatically when confirmation is off), so it is not part of the pre-commit file list in the confirmation window. That window shows a hint when the switch is on.
- If the AI model is unavailable or not configured, the code commit still proceeds without a README update; the result notice reports the reason.
- A private repository that the saved token cannot see is reported as missing by GitHub. Save anyway, or use a token with access to that repository or organization.
- Automatic recovery from a diverged remote creates a merge commit. If the remote and local trees conflict, the merge is aborted and the commit remains local; resolve the conflict manually and push.
- A short repository name (without `owner/`) is accepted only when the default prefix contains an account path, such as `https://github.com/<login>/`.
- The token is sent to git through an HTTP authorization header rather than a token-bearing URL, so it does not appear in the repository configuration, pushed history, or most error output.
- The branch dropdown and commit tree read local refs first, then check the remote with the same token used for pushes. A fetch happens only when the remote heads differ from the local `refs/remotes/dsh-auto-commit/*` refs; an unchanged remote leaves the local data untouched. The first read after a push may still fetch because pushes update the remote, not the local tracking refs. Without network access or a valid token, local branches/commits are still used and a warning is shown; the already-selected branch remains saveable.
- An existing branch is a push target, not a checkout switch. If that remote branch has diverged, the normal non-fast-forward recovery may create a merge commit before pushing.
- A new branch is created on the next commit, not at save time. Creating it can fail if checking out the base would overwrite uncommitted changes; commit or stash those changes first. A new-branch name that already exists on the remote is rejected.
- Merge, rebase, and rollback refuse to run on a dirty working tree. Merge and rebase abort on conflicts and leave the branch as it was. They do not force-push; a rebase that rewrites published history must be force-pushed manually if desired.
- Rollback restores the selected commit's **tree** as a new commit; it does not reset or delete history. The commit tree request fetches remote refs first and shows at most 1,000 commits. A rollback push is a normal push and can fail without discarding the local rollback commit.
- Version sync reads the remote head each time the Session dialog opens and after a new commit result; the check is read-only and time-limited, and an unreachable remote leaves the local view in place with a warning. The manual button then remains available as a retry, even when the sync check itself fails.
- A manual retry uses the saved repository/branch/README settings; save the settings form before retrying. A pending commit proposal must be resolved (confirm or skip) before another manual proposal can be created.
- A push-only retry does not create a new commit or generate a message; it pushes the existing local commits. A dirty-tree retry goes through the normal commit and confirmation flow.
- The top-of-sidebar Git settings button is shown while the sidebar is expanded; the per-Session configuration remains available from the Session's `…` menu when it is collapsed.
