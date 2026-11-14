# Git auto-commit

Commit and push a session's code changes after every completed turn, with a commit message written by the model from that turn's own changes.

## What it adds

- **Session row button and menu entry** — every Session row in the left sidebar gets a small git button on hover, and the same action appears in the Session's `…` menu (useful on touch devices and when the sidebar is narrow). It opens the per-session settings: enable auto-commit, repository, and branch. The feature is **off by default**; nothing is committed until the session is configured and enabled. An enabled Session also shows a small branch marker at rest in the row's trailing area, and a warning-colored marker while a commit is waiting for confirmation.
- **Workspace settings in the workspace `…` menu** — a workspace's default repository is configured from its own row menu (`Git auto-commit…`), with the same enabled / repository / branch controls. This DSH version exposes no workspace-row hover action seat, so the workspace `…` menu is the additive placement. A workspace default is a **template for sessions created afterwards**; editing it does not change existing sessions. It is off by default.
- **Git settings entry at the top of the sidebar** — a button beside **New session** opens the global settings:
  - default commit user name and email;
  - a private GitHub token (used for HTTPS pushes, stored in the DSH credential store, never written to the repository);
  - whether to ask for confirmation before each commit;
  - the GitHub account detected from the token and the default GitHub repository prefix;
  - whether to ask to create a repository that GitHub cannot find;
  - which AI provider and model generate project descriptions.
- **Token-derived GitHub prefix** — when a token is saved, the plugin calls GitHub's `GET /user`, stores the login, and sets the default prefix to `https://github.com/<login>/`. The prefix is editable. Repository fields accept:
  - a short name (`my-repo`) — appended to the prefix;
  - `owner/repo` — resolved against `github.com`;
  - a full URL (`https://github.com/owner/repo.git`) — stored as-is;
  - a local path — use an absolute path or start with `/`, `./`, `../`, or `~/`.
- **Missing-repository creation** — when a session or workspace is enabled with a GitHub repository that cannot be found, and the "ask to create" setting is on, a GitHub-style form opens with owner, name, description, visibility (private/public), README initialization, `.gitignore` template, license template, Issues/Projects/Wiki switches, and homepage. Creating the repository writes its clone URL back into the session or workspace configuration. "Do not create; save anyway" stores the name for a repository you create elsewhere. A short repository name needs an account prefix (detected from the token or set manually); otherwise use `owner/repo` or a full URL.
- **AI project description** — the create-repository form has an **AI generate** button next to Description. It reads the project's metadata (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and similar), README, file names, and a few source samples, then asks the AI configured in Git settings for a one-to-two-sentence GitHub description (at most 350 characters). The result fills the editable description field; the user can change it before creating the repository.
- **Independent confirmation window** — when confirmation is on, a modal opens after a turn. It shows the repository, branch, and the **uncommitted workspace changes**, and a freely editable commit message. Choose **Commit and push** to use that message, or **Skip this commit** to leave the working tree untouched. With **提交后隐藏窗口，后台完成** enabled (the default, remembered in the browser), confirming hides the window immediately and the commit/push continues in the background, so you can keep working in DSH; the result arrives as a notice. While a commit is running, the footer also shows **隐藏窗口**, and the window's close button or Escape hides it without cancelling. The window traps focus, focuses the message field, and does not dismiss on Escape before a decision is made; form dialogs keep unsaved edits when the backdrop or Escape is used.
- **AI commit messages** — the message is generated from the turn's user request, the agent's summary, the tool-touched files, and the git diff. It follows Conventional Commits (`feat(scope): subject`, then an optional body). If the model is unavailable, a deterministic `chore:` fallback is used.
- **Notices** — successful pushes, local-only commits, and failures are shown as a short notice.

## How a commit runs

1. A turn ends with the `completed` reason.
2. The plugin resolves the session repository (session override first, then the workspace default copied when the session was created) and expands a short name with the current GitHub prefix.
3. It ensures the session workspace is a git repository, stages all changes (`git add -A`), and asks the model for a message.
4. It commits with the configured name/email, then pushes `HEAD` to the configured branch through the repository URL or local path. The remote is also registered locally as `dsh-auto-commit`; an existing `origin` is never overwritten.
5. If pushing fails, the commit stays local and the notice shows the git error.
6. If the remote rejects the push because it has newer history (`fetch first` / non-fast-forward), the plugin fetches the configured branch, merges it with `--allow-unrelated-histories`, and retries the push once. A merge conflict aborts the merge and keeps the local commit, with a message asking for manual resolution.

## Background commits

After you confirm, the confirmation window can disappear while the Host keeps committing and pushing. The Session's sidebar marker reads **Committing in background** until the operation settles; success, local-only commits, and failures appear as the usual short notices. If the browser request itself fails before the Host records a result, the window reopens with the error so the proposal is not lost. The **hide after committing** choice is stored in the browser and defaults to on.

## AI project descriptions

Choose the provider and model in **Git settings → AI project description**. The selector loads the providers and models advertised by the running Harness, and shows the current agent default model as the fallback when no explicit selection is stored. The AI button is available in the create-repository form; it sends the session or workspace id so the Host can read the correct project directory.

The Host collects `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod` and similar metadata, the README, top-level and conventional source-directory file names, and up to four small source samples. It then asks the selected model for a concise description in the active UI language. If no explicit AI is configured, the agent default model is used. A model failure leaves the description unchanged and shows the error; the user can retry or type a description manually.

## GitHub identity and missing repositories

- The token is read from the DSH credential store and sent to GitHub only for `/user`, repo existence checks, and repo creation. Git pushes use an HTTP `Authorization` header, not a token-bearing URL.
- Existence checks run when a session or workspace is **enabled** with a GitHub repository, the "ask to create" setting is on, and a token is configured. Only `github.com` URLs are checked; an enterprise or other host is saved without an API check.
- A definitive `404` opens the create form. A `401`/`403`/network failure saves the configuration with a warning instead of blocking it.
- The token needs permission to create repositories on the selected owner: a classic token with `repo`, or a fine-grained token with repository creation/administration rights. For an organization owner, the token account must also be allowed to create repositories there.
- README initialization is **off by default**: an empty repository receives its first commit from the initial push. Enabling it creates a separate commit and can make the first push non-fast-forward; the form warns about this.

## Workspace defaults and new sessions

A workspace default is a **template**, not a live link:

- a session created after the workspace default was saved receives a copy of it;
- changing the workspace default later does **not** change any existing session;
- sessions that existed before the workspace default was saved stay off unless you configure them individually;
- session settings always win.

## Configuration and storage

- Global, per-session, and per-workspace settings live in `$DSH_HOME/git-auto-commit/state.json`.
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
- A private repository that the saved token cannot see is reported as missing by GitHub. Save anyway, or use a token with access to that repository or organization.
- Automatic recovery from a diverged remote creates a merge commit. If the remote and local trees conflict, the merge is aborted and the commit remains local; resolve the conflict manually and push.
- A short repository name (without `owner/`) is accepted only when the default prefix contains an account path, such as `https://github.com/<login>/`.
- The token is sent to git through an HTTP authorization header rather than a token-bearing URL, so it does not appear in the repository configuration, pushed history, or most error output.
- The top-of-sidebar Git settings button is shown while the sidebar is expanded; the per-Session configuration remains available from the Session's `…` menu when it is collapsed.
