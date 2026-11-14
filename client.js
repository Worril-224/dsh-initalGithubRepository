/**
 * dsh-git-auto-commit — Client half.
 *
 * Registers three seats:
 *   - `sidebar.workspaces.session.row.action`: one hover button per Session;
 *   - `sidebar.session.action` (HOC): a Git settings button beside New Session;
 *   - `shell.overlay`: the independent commit-confirmation modal and notices.
 *
 * All Host state is read through the package's same-origin POST routes.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-git-auto-commit',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-git-auto-commit'
    const API = '/api/dsh-git-auto-commit'
    const POLL_MS = 4000
    const modalStack = []

    /* ------------------------------------------------------------ */
    /* dictionaries                                                 */
    /* ------------------------------------------------------------ */

    const zh = {
      'session.actionTitle': '配置此会话的 Git 自动提交',
      'session.menuItem': 'Git 自动提交…',
      'session.on': '自动提交已开启',
      'session.off': '自动提交已关闭',
      'session.defaultOff': '默认关闭',
      'session.untitled': '未命名会话',
      'session.inherited': '继承自工作区默认',
      'session.config': '会话独立配置',
      'session.notConfigured': '尚未配置',
      'session.inheritedHint': '当前配置复制自工作区默认；在这里修改会保存为会话独立配置。',
      'session.pending': '有提交等待确认',
      'session.dialogTitle': '会话 Git 自动提交',
      'session.dialogSub': '每轮对话结束后，把本会话工作区的代码提交并推送到指定仓库。',
      'session.enabled': '启用此会话的自动提交',
      'session.repository': '代码仓库',
      'session.repositoryPlaceholder': '短名、owner/repo、完整 URL 或本地路径',
      'session.repositoryHint': '短名会拼接 Git 设置中的默认仓库前缀；owner/repo 使用 github.com；完整 URL 原样保存。本地路径请使用绝对路径或以 ./、../、~/ 开头。',
      'session.branch': '分支',
      'session.save': '保存',
      'session.reset': '恢复为工作区默认',
      'session.resetHint': '删除会话独立配置，重新按工作区默认解析（只对满足条件的新会话生效）。',
      'session.repoRequired': '启用自动提交前请填写代码仓库。',
      'session.pushNote': '启用后，每轮结束时会自动提交并推送。首次使用时会在工作区初始化 git 仓库。',
      'workspace.menuItem': 'Git 自动提交…',
      'workspace.dialogTitle': '工作区 Git 自动提交',
      'workspace.dialogSub': '这里的仓库只作为模板，复制给此后在该工作区新建的会话；修改不会影响已有会话。',
      'workspace.enabled': '为此工作区的新会话启用自动提交',
      'workspace.repository': '默认代码仓库',
      'workspace.branch': '默认分支',
      'workspace.save': '保存',
      'workspace.reset': '清除工作区默认',
      'workspace.hint': '新建会话时复制此配置；已存在的会话保持原配置。默认关闭。',
      'workspace.notConfigured': '未配置工作区默认',
      'workspace.notFound': '工作区不存在或已被删除。',
      'session.workspaceHint': '当前工作区：{name}',
      'session.noWorkspace': '该会话不属于任何已登记的工作区。',
      'settings.buttonTitle': 'Git 与提交设置',
      'settings.dialogTitle': 'Git 与提交设置',
      'settings.dialogSub': '配置默认提交身份、GitHub Token、提交确认，以及每个工作区的新会话默认仓库。',
      'settings.globalSection': '全局提交设置',
      'settings.userName': '提交用户名',
      'settings.userEmail': '提交邮箱',
      'settings.defaultBranch': '默认分支',
      'settings.defaultBranchHint': '新建会话或工作区未单独设置分支时使用。',
      'settings.token': 'GitHub Token',
      'settings.tokenPlaceholder': '留空则保持当前 Token 不变',
      'settings.tokenConfigured': '已保存 Token',
      'settings.tokenNotConfigured': '尚未保存 Token',
      'settings.tokenWillClear': '保存后将删除已保存的 Token。',
      'settings.tokenHint': 'Token 保存在本机 DSH 凭据库，不会写入仓库或提交历史。用于 HTTPS 推送。',
      'settings.clearToken': '清除已保存的 Token',
      'settings.pendingCount': '{n} 个提交等待确认',
      'settings.confirm': '提交前让我确认',
      'settings.confirmHint': '每轮结束后先弹出独立窗口；你可以自由修改 commit 信息，再决定是否使用。',
      'settings.githubSection': 'GitHub 账号与默认仓库前缀',
      'settings.githubAccountDetected': '已识别 GitHub 账号：{login}',
      'settings.githubAccountUnknown': '尚未识别 GitHub 账号；保存 Token 后自动获取。',
      'settings.githubPrefix': 'GitHub 默认仓库前缀',
      'settings.githubPrefixHint': '输入短仓库名（如 my-repo）时会拼接为该前缀；输入 owner/repo 或完整 URL 时不使用此前缀。',
      'settings.githubUserError': '无法识别 GitHub 账号',
      'settings.aiSection': 'AI 项目描述',
      'settings.aiProvider': 'AI 提供方',
      'settings.aiModel': 'AI 模型',
      'settings.aiDefault': '默认（Agent 默认模型）',
      'settings.aiModelDefault': '默认模型',
      'settings.aiModelPlaceholder': '请选择模型',
      'settings.aiHint': '用于新建仓库时根据项目文件生成描述。留空则使用当前 Agent 的默认模型。',
      'settings.aiLoading': '正在加载模型…',
      'settings.aiLoadFailed': '无法加载模型：{error}',
      'settings.aiRefresh': '刷新模型',
      'settings.aiNoModels': '该提供方没有可用模型',
      'settings.aiModelRequired': '选择提供方后需要选择一个模型。',
      'settings.askCreateMissingRepo': '仓库不存在时询问是否创建',
      'settings.askCreateMissingRepoHint': '保存会话或工作区仓库时，如果 GitHub 上查不到，会打开创建仓库表单。关闭后不再检查。',
      'settings.workspaceSection': '工作区默认仓库',
      'settings.workspaceHint': '这里保存的仓库只作为模板，复制给此后在该工作区新建的会话；修改不会影响已存在的会话。默认关闭。',
      'settings.noWorkspaces': '暂无已登记的工作区。',
      'settings.workspaceEnabled': '为此工作区的新会话启用',
      'settings.workspaceRepo': '仓库',
      'settings.workspaceBranch': '分支',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.saved': '设置已保存',
      'settings.repoRequired': '工作区启用前需要填写仓库地址。',
      'confirm.title': '确认本轮提交',
      'confirm.sub': '模型已根据本轮改动生成 commit 信息。你可以直接修改后再提交。',
      'confirm.session': '会话：{name}',
      'confirm.repository': '仓库',
      'confirm.branch': '分支',
      'confirm.files': '工作区未提交改动（{n} 个文件）',
      'confirm.filesHint': '包含本轮之前尚未提交的改动；提交会暂存整个工作区。',
      'confirm.message': 'Commit 信息',
      'confirm.messageHint': '第一行是标题，空一行后可以写正文。',
      'confirm.commit': '提交并推送',
      'confirm.skip': '跳过本次',
      'confirm.skipHint': '跳过不会丢弃改动；它们会保留在工作区。',
      'confirm.working': '正在提交…',
      'confirm.moreFiles': '还有 {n} 个文件未列出',
      'confirm.emptyMessage': 'Commit 信息不能为空。',
      'toast.pushed': '已提交并推送到 {repo}',
      'toast.committed': '已提交（推送失败，提交保留在本地）',
      'toast.commitFailed': '提交失败',
      'toast.pushFailedTitle': '已提交，但推送失败',
      'toast.pushFailed': '已提交，但推送失败：{error}',
      'toast.cancelled': '已跳过本次提交',
      'toast.error': '自动提交失败',
      'repo.missingNotice': 'GitHub 上找不到 {repo}。是否现在创建这个仓库？',
      'repo.createTitle': '在 GitHub 创建仓库',
      'repo.createSub': '填写 GitHub 创建仓库所需的信息；创建成功后会把该仓库写入当前配置。',
      'repo.owner': '所有者',
      'repo.ownerHint': '留空表示当前 Token 的账号；也可以填写组织名。',
      'repo.name': '仓库名',
      'repo.aiDescribe': 'AI 生成描述',
      'repo.aiDescribing': 'AI 生成中…',
      'repo.aiHint': '从项目文件生成；使用 Git 设置中选择的 AI。',
      'repo.aiFailed': 'AI 生成失败',
      'repo.description': '描述',
      'repo.visibility': '可见性',
      'repo.private': '私有（Private）',
      'repo.public': '公开（Public）',
      'repo.autoInit': '创建时初始化 README',
      'repo.autoInitHint': '新建的空仓库在首次推送时会创建初始提交；勾选 README 初始化会产生一个独立提交，可能导致首次推送被拒绝。',
      'repo.gitignore': '.gitignore 模板',
      'repo.license': '许可证模板',
      'repo.hasIssues': '启用 Issues',
      'repo.hasProjects': '启用 Projects',
      'repo.hasWiki': '启用 Wiki',
      'repo.homepage': '主页',
      'repo.create': '创建并保存',
      'repo.back': '返回',
      'repo.saveAnyway': '不创建，仍然保存',
      'repo.creating': '正在创建…',
      'repo.nameHint': '1–100 个字母、数字、点、短横线或下划线。',
      'repo.optionalHint': '可选；留空则不使用模板。',
      'repo.created': '已创建 {repo}',
      'repo.createFailed': '创建仓库失败',
      'repo.tokenRequired': '创建仓库需要先在 Git 设置中保存 GitHub Token。',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.loading': '加载中…',
      'common.error': '出错了',
      'common.retry': '重试',
      'common.optional': '可选',
      'common.unknown': '未知',
    }

    const en = {
      'session.actionTitle': 'Configure git auto-commit for this session',
      'session.menuItem': 'Git auto-commit…',
      'session.on': 'Auto-commit is on',
      'session.off': 'Auto-commit is off',
      'session.defaultOff': 'Off by default',
      'session.untitled': 'Untitled session',
      'session.inherited': 'Inherited from the workspace default',
      'session.config': 'Session-specific configuration',
      'session.notConfigured': 'Not configured',
      'session.inheritedHint': 'This configuration was copied from the workspace default; editing it here saves a session-specific override.',
      'session.pending': 'A commit is waiting for confirmation',
      'session.dialogTitle': 'Session git auto-commit',
      'session.dialogSub': 'After each turn, commit and push this session workspace to the configured repository.',
      'session.enabled': 'Enable auto-commit for this session',
      'session.repository': 'Repository',
      'session.repositoryPlaceholder': 'Short name, owner/repo, full URL, or local path',
      'session.repositoryHint': 'A short name uses the default repository prefix from Git settings; owner/repo uses github.com; full URLs are stored as-is. Prefix local paths with /, ./, ../, or ~.',
      'session.branch': 'Branch',
      'session.save': 'Save',
      'session.reset': 'Use workspace default',
      'session.resetHint': 'Remove the session override and resolve from the workspace default again (only new eligible sessions inherit it).',
      'session.repoRequired': 'Set a repository before enabling auto-commit.',
      'session.pushNote': 'When enabled, each completed turn is committed and pushed. A git repository is initialized in the workspace on first use.',
      'workspace.menuItem': 'Git auto-commit…',
      'workspace.dialogTitle': 'Workspace git auto-commit',
      'workspace.dialogSub': 'This repository is a template copied into sessions created in this workspace afterwards; editing it does not affect existing sessions.',
      'workspace.enabled': 'Enable auto-commit for new sessions in this workspace',
      'workspace.repository': 'Default repository',
      'workspace.branch': 'Default branch',
      'workspace.save': 'Save',
      'workspace.reset': 'Clear workspace default',
      'workspace.hint': 'New sessions copy this configuration; existing sessions keep theirs. Off by default.',
      'workspace.notConfigured': 'No workspace default configured',
      'workspace.notFound': 'The workspace no longer exists.',
      'session.workspaceHint': 'Workspace: {name}',
      'session.noWorkspace': 'This session does not belong to a registered workspace.',
      'settings.buttonTitle': 'Git and commit settings',
      'settings.dialogTitle': 'Git and commit settings',
      'settings.dialogSub': 'Default commit identity, GitHub token, commit confirmation, and per-workspace defaults for new sessions.',
      'settings.globalSection': 'Global commit settings',
      'settings.userName': 'Commit user name',
      'settings.userEmail': 'Commit email',
      'settings.defaultBranch': 'Default branch',
      'settings.defaultBranchHint': 'Used when a session or workspace does not set its own branch.',
      'settings.token': 'GitHub token',
      'settings.tokenPlaceholder': 'Leave blank to keep the current token',
      'settings.tokenConfigured': 'Token saved',
      'settings.tokenNotConfigured': 'No token saved',
      'settings.tokenWillClear': 'Saving will remove the stored token.',
      'settings.tokenHint': 'The token is stored in this machine\'s DSH credential store and is never written to a repository or commit history. It is used for HTTPS pushes.',
      'settings.clearToken': 'Clear the saved token',
      'settings.pendingCount': '{n} commit(s) waiting for confirmation',
      'settings.confirm': 'Ask me before committing',
      'settings.confirmHint': 'After each turn an independent window opens; edit the commit message freely and decide whether to use it.',
      'settings.githubSection': 'GitHub account and default repository prefix',
      'settings.githubAccountDetected': 'Detected GitHub account: {login}',
      'settings.githubAccountUnknown': 'No GitHub account detected yet; save a token to detect it.',
      'settings.githubPrefix': 'Default GitHub repository prefix',
      'settings.githubPrefixHint': 'A short repository name (for example my-repo) is appended to this prefix. Use owner/repo or a full URL to bypass it.',
      'settings.githubUserError': 'Could not detect the GitHub account',
      'settings.aiSection': 'AI project description',
      'settings.aiProvider': 'AI provider',
      'settings.aiModel': 'AI model',
      'settings.aiDefault': 'Default (agent default model)',
      'settings.aiModelDefault': 'Default model',
      'settings.aiModelPlaceholder': 'Choose a model',
      'settings.aiHint': 'Used to generate a repository description from project files. Leave empty to use the current agent default model.',
      'settings.aiLoading': 'Loading models…',
      'settings.aiLoadFailed': 'Could not load models: {error}',
      'settings.aiRefresh': 'Refresh models',
      'settings.aiNoModels': 'No models are available for this provider',
      'settings.aiModelRequired': 'Choose a model after selecting a provider.',
      'settings.askCreateMissingRepo': 'Ask to create a missing repository',
      'settings.askCreateMissingRepoHint': 'When a session or workspace repository is saved and GitHub cannot find it, open the create-repository form. Turning this off skips the check.',
      'settings.workspaceSection': 'Workspace default repositories',
      'settings.workspaceHint': 'These repositories are templates copied into sessions created in the workspace afterwards. Editing them does not affect existing sessions. Off by default.',
      'settings.noWorkspaces': 'No registered workspaces yet.',
      'settings.workspaceEnabled': 'Enable for new sessions in this workspace',
      'settings.workspaceRepo': 'Repository',
      'settings.workspaceBranch': 'Branch',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.saved': 'Settings saved',
      'settings.repoRequired': 'A repository is required before enabling a workspace.',
      'confirm.title': 'Confirm this commit',
      'confirm.sub': 'The model wrote a commit message from this turn\'s changes. Edit it freely before committing.',
      'confirm.session': 'Session: {name}',
      'confirm.repository': 'Repository',
      'confirm.branch': 'Branch',
      'confirm.files': 'Uncommitted workspace changes ({n} files)',
      'confirm.filesHint': 'Includes changes left uncommitted by earlier turns; committing stages the whole workspace.',
      'confirm.message': 'Commit message',
      'confirm.messageHint': 'The first line is the subject; leave a blank line before the body.',
      'confirm.commit': 'Commit and push',
      'confirm.skip': 'Skip this commit',
      'confirm.skipHint': 'Skipping keeps the changes in the workspace; nothing is discarded.',
      'confirm.working': 'Committing…',
      'confirm.moreFiles': '{n} more files not listed',
      'confirm.emptyMessage': 'The commit message cannot be empty.',
      'toast.pushed': 'Committed and pushed to {repo}',
      'toast.committed': 'Committed (push failed; the commit is kept locally)',
      'toast.commitFailed': 'Commit failed',
      'toast.pushFailedTitle': 'Committed, but push failed',
      'toast.pushFailed': 'Committed, but push failed: {error}',
      'toast.cancelled': 'This commit was skipped',
      'toast.error': 'Auto-commit failed',
      'repo.missingNotice': 'GitHub could not find {repo}. Create it now?',
      'repo.createTitle': 'Create a GitHub repository',
      'repo.createSub': 'Fill in the information GitHub needs; the created repository is written into the current configuration.',
      'repo.owner': 'Owner',
      'repo.ownerHint': 'Leave blank for the token account, or enter an organization name.',
      'repo.name': 'Repository name',
      'repo.aiDescribe': 'Generate with AI',
      'repo.aiDescribing': 'Generating…',
      'repo.aiHint': 'Generated from project files using the AI chosen in Git settings.',
      'repo.aiFailed': 'AI generation failed',
      'repo.description': 'Description',
      'repo.visibility': 'Visibility',
      'repo.private': 'Private',
      'repo.public': 'Public',
      'repo.autoInit': 'Initialize with a README',
      'repo.autoInitHint': 'An empty repository gets its first commit from the initial push. A README initialization creates a separate commit and can make the first push non-fast-forward.',
      'repo.gitignore': '.gitignore template',
      'repo.license': 'License template',
      'repo.hasIssues': 'Enable Issues',
      'repo.hasProjects': 'Enable Projects',
      'repo.hasWiki': 'Enable Wiki',
      'repo.homepage': 'Homepage',
      'repo.create': 'Create and save',
      'repo.back': 'Back',
      'repo.saveAnyway': 'Do not create; save anyway',
      'repo.creating': 'Creating…',
      'repo.nameHint': '1–100 letters, digits, dots, dashes, or underscores.',
      'repo.optionalHint': 'Optional; leave blank to use no template.',
      'repo.created': 'Created {repo}',
      'repo.createFailed': 'Could not create the repository',
      'repo.tokenRequired': 'Creating a repository needs a GitHub token saved in Git settings.',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.loading': 'Loading…',
      'common.error': 'Something went wrong',
      'common.retry': 'Retry',
      'common.optional': 'Optional',
      'common.unknown': 'Unknown',
    }

    /* ------------------------------------------------------------ */
    /* styles                                                       */
    /* ------------------------------------------------------------ */

    const CSS = `
.dsh-git-rowbtn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:-4px;padding:0;border:none;border-radius:var(--dsw-radius-xs,6px);background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;transition:color .15s ease,background-color .15s ease}
.dsh-git-rowbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-git-rowbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-git-rowbtn[data-enabled="true"]{color:var(--dsw-alias-brand-primary)}
.dsh-git-rowbtn .dsh-git-on-dot{position:absolute;right:2px;bottom:2px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}
.dsh-git-newbtn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;padding:0;border:0.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-specific-sidebar-glass-fill,var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-2)));color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-git-newbtn:hover{background:var(--dsw-specific-sidebar-glass-hover,var(--dsw-alias-button-floating-hover,var(--dsw-alias-interactive-bg-hover)));color:var(--dsw-alias-label-primary)}
.dsh-git-newbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-git-newbtn .dsh-git-badge{position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base))}
.dsh-git-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));box-sizing:border-box}
.dsh-git-modal{box-sizing:border-box;width:min(620px,100%);max-height:min(86vh,820px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3,0 18px 48px rgba(0,0,0,.28));font-size:13px;line-height:1.5}
.dsh-git-modal.is-wide{width:min(760px,100%)}
.dsh-git-modal-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-git-modal-headings{flex:1;min-width:0}
.dsh-git-modal-title{font-size:15px;font-weight:600;line-height:1.3}
.dsh-git-modal-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.dsh-git-close{flex:none;width:26px;height:26px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:1;cursor:pointer}
.dsh-git-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dsh-git-modal-body{padding:16px 20px;overflow-y:auto;min-height:0}
.dsh-git-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
.dsh-git-field:last-child{margin-bottom:0}
.dsh-git-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-git-label-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsh-git-ai-btn{min-height:24px;padding:0 8px;font-size:11px;flex:none}
.dsh-git-label .dsh-git-optional{font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:6px}
.dsh-git-input,.dsh-git-textarea,.dsh-git-select{box-sizing:border-box;width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dsh-git-input:focus,.dsh-git-textarea:focus,.dsh-git-select:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-git-input::placeholder,.dsh-git-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dsh-git-textarea{min-height:148px;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);line-height:1.55}
.dsh-git-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
@media (max-width:620px){.dsh-git-grid2{grid-template-columns:minmax(0,1fr)}}
.dsh-git-hint{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}
.dsh-git-switchrow{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin-bottom:14px}
.dsh-git-switchrow .dsh-git-switchtext{flex:1;min-width:0}
.dsh-git-switchrow .dsh-git-switchtitle{font-size:12.5px;font-weight:600}
.dsh-git-switch{position:relative;flex:none;width:36px;height:20px;margin-top:1px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-state-idle-primary,rgba(127,127,127,.35));cursor:pointer;transition:background-color .15s ease}
.dsh-git-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.dsh-git-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-git-switch:disabled{opacity:.5;cursor:default}
.dsh-git-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.dsh-git-switch[aria-checked="true"] .dsh-git-knob{transform:translateX(16px)}
.dsh-git-section{margin-top:18px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-git-section-title{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600}
.dsh-git-wslist{display:flex;flex-direction:column;gap:10px;margin-top:10px;max-height:300px;overflow-y:auto;padding-right:4px}
.dsh-git-ws{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}
.dsh-git-ws-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}
.dsh-git-ws-title{flex:1;min-width:0;font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.dsh-git-ws-path{color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere;margin-top:2px}
.dsh-git-ws-switch{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.dsh-git-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-git-actions .dsh-git-actions-left{margin-right:auto;display:flex;align-items:center;gap:10px}
.dsh-git-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dsh-git-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-git-btn:focus-visible,.dsh-git-close:focus-visible,.dsh-git-toast-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-git-btn:disabled{opacity:.55;cursor:default}
.dsh-git-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-git-btn-primary:hover:enabled{filter:brightness(1.05)}
.dsh-git-btn-subtle{border-color:transparent;background:transparent;color:var(--dsw-alias-brand-primary)}
.dsh-git-btn-subtle:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-git-error{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.dsh-git-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.dsh-git-checkgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin:2px 0 14px}
.dsh-git-checkrow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-git-checkrow input{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary)}
.dsh-git-success{color:var(--dsw-alias-state-success-primary);font-size:12px}
.dsh-git-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}
.dsh-git-chip[data-on="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dsh-git-filebox{margin-top:6px;max-height:130px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:7px 9px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.55}
.dsh-git-filebox div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dsh-git-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:4px 10px;font-size:12px;margin-bottom:10px}
.dsh-git-kv .dsh-git-k{color:var(--dsw-alias-label-secondary)}
.dsh-git-kv .dsh-git-v{overflow-wrap:anywhere;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.dsh-git-loading{color:var(--dsw-alias-label-secondary);font-size:12px;padding:10px 0}
.dsh-git-toast{position:fixed;right:20px;bottom:20px;z-index:2147483001;display:flex;align-items:flex-start;gap:10px;max-width:min(420px,calc(100vw - 40px));padding:11px 12px 11px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.25));font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.dsh-git-toast-body{flex:1;min-width:0}
.dsh-git-toast-close{flex:none;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-git-toast-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dsh-git-trailing{display:inline-flex;align-items:center;gap:3px;flex:none;color:var(--dsw-alias-brand-primary);margin-inline-start:2px}
.dsh-git-trailing[data-pending="true"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-git-trailing svg{display:block}
.dsh-git-menuitem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsh-git-menuitem:hover,.dsh-git-menuitem:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-git-menuitem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
@media (prefers-reduced-motion: reduce){.dsh-git-rowbtn,.dsh-git-newbtn,.dsh-git-switch,.dsh-git-knob,.dsh-git-btn{transition:none}}
.dsh-git-toast[data-tone="success"]{border-left:3px solid var(--dsw-alias-state-success-primary)}
.dsh-git-toast[data-tone="warn"]{border-left:3px solid var(--dsw-alias-state-warn-primary)}
.dsh-git-toast[data-tone="error"]{border-left:3px solid var(--dsw-alias-state-error-primary)}
.dsh-git-toast-title{font-weight:600;margin-bottom:2px}
.dsh-git-toast-detail{color:var(--dsw-alias-label-secondary);font-size:11.5px}
`

    /* ------------------------------------------------------------ */
    /* tiny API + store                                             */
    /* ------------------------------------------------------------ */

    async function apiCall(route, body, timeoutMs = 15000) {
      let response
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        response = await fetch(`${API}/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
          signal: controller.signal,
        })
      } catch (error) {
        throw new Error(`Cannot reach the plugin host (${error && error.message ? error.message : 'network error'})`)
      } finally {
        clearTimeout(timeout)
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error(`Host 路由 HTTP ${response.status}`)
      if (payload === null || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : 'Host request failed'
        const error = new Error(message)
        error.code = payload && payload.error ? payload.error.code : undefined
        error.details = payload && payload.error ? payload.error.details : undefined
        throw error
      }
      return payload
    }

    function createStore(localeId) {
      let snapshot = {
        loaded: false,
        loading: false,
        error: null,
        state: null,
        sessionConfigs: {},
        sessionMeta: {},
        sessionErrors: {},
        dialog: null,
        workspaceDialog: null,
        aiCatalog: {
          loading: false,
          loaded: false,
          providers: [],
          provider: '',
          models: [],
          selected: null,
          error: null,
        },
      }
      const listeners = new Set()
      const sessionRequests = new Map()
      let pollTimer = null
      let refreshRequest = null
      let generation = 0
      let aiGeneration = 0

      function emit() {
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-git-auto-commit] listener failed', error)
          }
        }
      }

      function set(patch) {
        snapshot = { ...snapshot, ...patch }
        emit()
      }

      async function refresh() {
        if (refreshRequest !== null) return refreshRequest
        const ticket = ++generation
        refreshRequest = (async () => {
          set({ loading: true })
          try {
            const data = await apiCall('state', {})
            if (ticket !== generation) return
            set({ loaded: true, loading: false, error: null, state: data })
          } catch (error) {
            if (ticket !== generation) return
            set({ loading: false, error: error && error.message ? error.message : String(error) })
          } finally {
            refreshRequest = null
          }
        })()
        return refreshRequest
      }

      async function ensureSession(sessionId, force = false) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        if (!force && snapshot.sessionConfigs[sessionId] !== undefined) return snapshot.sessionConfigs[sessionId]
        if (!force && sessionRequests.has(sessionId)) return sessionRequests.get(sessionId)
        if (force) {
          const configs = { ...snapshot.sessionConfigs }
          const meta = { ...snapshot.sessionMeta }
          const errors = { ...snapshot.sessionErrors }
          delete configs[sessionId]
          delete meta[sessionId]
          delete errors[sessionId]
          snapshot = { ...snapshot, sessionConfigs: configs, sessionMeta: meta, sessionErrors: errors }
          emit()
        }
        const request = (async () => {
          try {
            const data = await apiCall('session-state', { sessionId })
            const errors = { ...snapshot.sessionErrors }
            delete errors[sessionId]
            snapshot = {
              ...snapshot,
              sessionConfigs: { ...snapshot.sessionConfigs, [sessionId]: data.config },
              sessionMeta: {
                ...snapshot.sessionMeta,
                [sessionId]: { workspace: data.workspace, session: data.session, global: data.global },
              },
              sessionErrors: errors,
            }
            emit()
            return data.config
          } catch (error) {
            snapshot = {
              ...snapshot,
              sessionErrors: {
                ...snapshot.sessionErrors,
                [sessionId]: error && error.message ? error.message : String(error),
              },
            }
            emit()
            return null
          } finally {
            sessionRequests.delete(sessionId)
          }
        })()
        sessionRequests.set(sessionId, request)
        return request
      }

      async function saveSession(sessionId, patch) {
        const data = await apiCall('session', { sessionId, ...patch })
        const errors = { ...snapshot.sessionErrors }
        delete errors[sessionId]
        snapshot = {
          ...snapshot,
          sessionConfigs: { ...snapshot.sessionConfigs, [sessionId]: data.config },
          sessionErrors: errors,
        }
        emit()
        void refresh()
        return data.config
      }

      async function saveConfig(payload) {
        const data = await apiCall('config', payload)
        await refresh()
        return data
      }

      async function saveWorkspace(workspaceId, patch) {
        const data = await apiCall('workspace', { workspaceId, ...patch })
        void refresh()
        return data
      }

      async function createGitHubRepo(payload) {
        return apiCall('github/create-repo', payload)
      }

      async function loadAiModels(provider) {
        const ticket = ++aiGeneration
        set({ aiCatalog: { ...snapshot.aiCatalog, loading: true, error: null } })
        try {
          const data = await apiCall('ai/models', { provider: provider || '' })
          if (ticket !== aiGeneration) return null
          snapshot = {
            ...snapshot,
            aiCatalog: {
              loading: false,
              loaded: true,
              providers: Array.isArray(data.providers) ? data.providers : [],
              provider: typeof data.provider === 'string' ? data.provider : '',
              models: Array.isArray(data.models) ? data.models : [],
              selected: data.selected || null,
              error: data.error || null,
            },
          }
          emit()
          return data
        } catch (error) {
          if (ticket !== aiGeneration) return null
          snapshot = {
            ...snapshot,
            aiCatalog: {
              ...snapshot.aiCatalog,
              loading: false,
              loaded: true,
              provider: provider || snapshot.aiCatalog.provider,
              error: error && error.message ? error.message : String(error),
            },
          }
          emit()
          return null
        }
      }

      async function describeProject(payload) {
        return apiCall('ai/describe', payload, 60000)
      }

      function openWorkspaceDialog(workspaceId, displayTitle) {
        set({ workspaceDialog: { workspaceId, displayTitle: displayTitle || '' } })
        if (!snapshot.loaded) void refresh()
      }

      function closeWorkspaceDialog() {
        set({ workspaceDialog: null })
      }

      async function decide(pendingId, action, message) {
        // Commit + push can wait on git's network timeout, so this route gets a
        // longer browser deadline than ordinary state reads.
        const data = await apiCall('pending', { id: pendingId, action, message }, 240000)
        void refresh()
        return data
      }

      function openSessionDialog(sessionId, displayTitle) {
        set({ dialog: { sessionId, displayTitle: displayTitle || '' } })
        void ensureSession(sessionId)
      }

      function closeSessionDialog() {
        set({ dialog: null })
      }

      function start() {
        void refresh()
        pollTimer = setInterval(() => { void refresh() }, POLL_MS)
      }

      function stop() {
        if (pollTimer !== null) clearInterval(pollTimer)
        pollTimer = null
      }

      function subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      function get() {
        return snapshot
      }

      return { get, subscribe, start, stop, refresh, ensureSession, saveSession, saveConfig, saveWorkspace, createGitHubRepo, loadAiModels, describeProject, localeId, decide, openSessionDialog, closeSessionDialog, openWorkspaceDialog, closeWorkspaceDialog }
    }

    function useStore(store) {
      const [, setTick] = useState(0)
      useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store])
      return store.get()
    }

    /* ------------------------------------------------------------ */
    /* shared bits                                                  */
    /* ------------------------------------------------------------ */

    function BranchIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.9,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 6, cy: 5, r: 2.1 }),
        h('circle', { cx: 6, cy: 19, r: 2.1 }),
        h('circle', { cx: 18, cy: 7, r: 2.1 }),
        h('path', { d: 'M6 7.1v9.8' }),
        h('path', { d: 'M18 9.1v1.4a4 4 0 0 1-4 4H9.5' }),
        h('path', { d: 'M11.5 12l-2.5 2.5 2.5 2.5' }),
      )
    }

    function GearIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 12, cy: 12, r: 3.2 }),
        h('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.6.76 1 1.4 1H21a2 2 0 1 1 0 4h-.09c-.64 0-1.2.4-1.4 1Z' }),
      )
    }

    function Switch({ checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'dsh-git-switch',
        disabled: disabled === true,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dsh-git-knob' }))
    }

    function Field({ label, optional, hint, children }) {
      return h('div', { className: 'dsh-git-field' },
        h('div', { className: 'dsh-git-label' }, label, optional ? h('span', { className: 'dsh-git-optional' }, optional) : null),
        children,
        hint ? h('div', { className: 'dsh-git-hint' }, hint) : null,
      )
    }

    function Modal({ title, subtitle, children, footer, onClose, wide, closeLabel, guardClose }) {
      const modalRef = useRef(null)
      const onCloseRef = useRef(onClose)
      const guardRef = useRef(guardClose)
      onCloseRef.current = onClose
      guardRef.current = guardClose
      useEffect(() => {
        const id = {}
        modalStack.push(id)
        const node = modalRef.current
        const previous = document.activeElement
        const focusables = () => {
          if (node === null) return []
          return Array.from(node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        }
        const initial = node === null
          ? null
          : node.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') || focusables()[0] || node
        if (initial !== null && typeof initial.focus === 'function') {
          try { initial.focus() } catch { /* focus is best effort */ }
        }
        const onKey = (event) => {
          if (modalStack[modalStack.length - 1] !== id) return
          if (event.key === 'Escape') {
            if (modalStack[modalStack.length - 1] !== id) return
            event.preventDefault()
            event.stopPropagation()
            if (typeof onCloseRef.current !== 'function') return
            if (typeof guardRef.current === 'function' && guardRef.current() === false) return
            onCloseRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (items.length === 0) {
            event.preventDefault()
            if (node !== null) node.focus()
            return
          }
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          const index = modalStack.indexOf(id)
          if (index >= 0) modalStack.splice(index, 1)
          if (previous !== null && typeof previous.focus === 'function' && document.contains(previous)) {
            try { previous.focus() } catch { /* focus is best effort */ }
          }
        }
      }, [])
      const requestClose = () => {
        if (typeof onClose !== 'function') return
        if (typeof guardClose === 'function' && guardClose() === false) return
        onClose()
      }
      const node = h('div', {
        className: 'dsh-git-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) requestClose()
        },
      }, h('div', {
        ref: modalRef,
        tabIndex: -1,
        className: `dsh-git-modal${wide ? ' is-wide' : ''}`,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
      },
      h('div', { className: 'dsh-git-modal-head' },
        h('div', { className: 'dsh-git-modal-headings' },
          h('div', { className: 'dsh-git-modal-title' }, title),
          subtitle ? h('div', { className: 'dsh-git-modal-sub' }, subtitle) : null,
        ),
        typeof onClose === 'function'
          ? h('button', { type: 'button', className: 'dsh-git-close', 'aria-label': closeLabel || 'Close', onClick: onClose }, '×')
          : null,
      ),
      h('div', { className: 'dsh-git-modal-body' }, children),
      footer ? h('div', { className: 'dsh-git-actions' }, footer) : null,
      ))
      return ReactDOM.createPortal(node, document.body)
    }

    function repoLabel(repository) {
      const value = String(repository || '')
      const match = value.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i)
      if (match) return `${match[1]}/${match[2]}`
      return value
    }

    function sourceLabel(source, t) {
      if (source === 'workspace') return t('session.inherited')
      if (source === 'session') return t('session.config')
      return t('session.notConfigured')
    }

    /* ------------------------------------------------------------ */
    /* session dialog                                               */
    /* ------------------------------------------------------------ */

    function SessionGitDialog({ sessionId, displayTitle, store, t, onClose }) {
      const snap = useStore(store)
      const config = snap.sessionConfigs[sessionId]
      const meta = snap.sessionMeta[sessionId]
      const defaultBranch = (snap.state && snap.state.global && snap.state.global.defaultBranch) || 'main'
      const [enabled, setEnabled] = useState(Boolean(config && config.enabled))
      const [repository, setRepository] = useState(config && config.repository ? config.repository : '')
      const [branch, setBranch] = useState(config && config.branch ? config.branch : defaultBranch)
      const [seeded, setSeeded] = useState(Boolean(config))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)
      const [warning, setWarning] = useState(null)
      const [missingRepo, setMissingRepo] = useState(null)
      const firstInput = useRef(null)
      const focused = useRef(false)
      const initial = useRef(config
        ? {
          enabled: Boolean(config.enabled),
          repository: config.repository || '',
          branch: config.branch || defaultBranch,
        }
        : null)

      useEffect(() => {
        void store.ensureSession(sessionId)
      }, [store, sessionId])

      useEffect(() => {
        if (config !== undefined && !seeded) {
          const values = {
            enabled: Boolean(config.enabled),
            repository: config.repository || '',
            branch: config.branch || defaultBranch,
          }
          setEnabled(values.enabled)
          setRepository(values.repository)
          setBranch(values.branch)
          initial.current = values
          setSeeded(true)
        }
      }, [config, seeded, defaultBranch])

      useEffect(() => {
        if (seeded && !focused.current) {
          focused.current = true
          if (firstInput.current) firstInput.current.focus()
        }
      }, [seeded])

      const sessionError = snap.sessionErrors[sessionId] || (!config && snap.error ? snap.error : null)
      const ready = config !== undefined
      const dirty = ready && initial.current !== null && (
        enabled !== initial.current.enabled
        || repository !== initial.current.repository
        || branch !== initial.current.branch
      )

      const persist = async (values, skipRepoCheck) => {
        setError(null)
        setWarning(null)
        setSaved(false)
        setSaving(true)
        try {
          const data = await store.saveSession(sessionId, { ...values, skipRepoCheck: skipRepoCheck === true })
          initial.current = { ...values }
          setSaved(true)
          setSeeded(true)
          if (data.repoCheckWarning) setWarning(data.repoCheckWarning)
          setTimeout(() => onClose(), 320)
        } catch (submitError) {
          if (submitError && submitError.code === 'REPO_NOT_FOUND' && submitError.details) {
            setMissingRepo(submitError.details)
            return
          }
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setSaving(false)
        }
      }

      const save = () => {
        if (!ready) return
        if (enabled && repository.trim() === '') {
          setError(t('session.repoRequired'))
          return
        }
        void persist({
          enabled,
          repository: repository.trim(),
          branch: branch.trim() || defaultBranch,
        }, false)
      }

      const reset = async () => {
        if (!ready) return
        setError(null)
        setSaving(true)
        try {
          await store.saveSession(sessionId, { reset: true })
          onClose()
        } catch (submitError) {
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setSaving(false)
        }
      }

      const title = displayTitle && displayTitle !== '' ? displayTitle : t('session.untitled')
      const explicit = config !== undefined && config.source === 'session'
      const workspace = meta && meta.workspace
      const loading = !ready && sessionError === null

      return h(React.Fragment, null,
        h(Modal, {
        title: t('session.dialogTitle'),
        subtitle: `${t('confirm.session', { name: title })} · ${sourceLabel(config && config.source, t)}`,
        onClose,
        closeLabel: t('common.close'),
        guardClose: () => !dirty,
        children: loading
          ? h('div', { className: 'dsh-git-loading' }, t('common.loading'))
          : !ready
            ? h(React.Fragment, null,
              h('div', { className: 'dsh-git-error' }, sessionError || t('common.error')),
              h('div', { style: { marginTop: 12 } },
                h('button', {
                  type: 'button',
                  className: 'dsh-git-btn',
                  onClick: () => { void store.ensureSession(sessionId, true) },
                }, t('common.retry')),
              ),
            )
            : h(React.Fragment, null,
              h('div', { className: 'dsh-git-switchrow' },
                h('div', { className: 'dsh-git-switchtext' },
                  h('div', { className: 'dsh-git-switchtitle' }, t('session.enabled')),
                  h('div', { className: 'dsh-git-hint' }, t('session.pushNote')),
                ),
                h(Switch, { checked: enabled, onChange: setEnabled, label: t('session.enabled') }),
              ),
              h(Field, {
                label: t('session.repository'),
                hint: t('session.repositoryHint'),
              }, h('input', {
                ref: firstInput,
                className: 'dsh-git-input',
                'aria-label': t('session.repository'),
                value: repository,
                placeholder: t('session.repositoryPlaceholder'),
                spellCheck: false,
                onChange: (event) => setRepository(event.target.value),
              })),
              h(Field, { label: t('session.branch') }, h('input', {
                className: 'dsh-git-input',
                'aria-label': t('session.branch'),
                value: branch,
                placeholder: defaultBranch,
                spellCheck: false,
                onChange: (event) => setBranch(event.target.value),
              })),
              workspace
                ? h('div', { className: 'dsh-git-hint' }, t('session.workspaceHint', { name: workspace.title }))
                : h('div', { className: 'dsh-git-hint' }, t('session.noWorkspace')),
              config && config.source === 'workspace'
                ? h('div', { className: 'dsh-git-hint' }, t('session.inheritedHint'))
                : h('div', { className: 'dsh-git-hint' }, t('session.resetHint')),
              warning ? h('div', { className: 'dsh-git-warn' }, warning) : null,
              error ? h('div', { className: 'dsh-git-error' }, error) : null,
              saved ? h('div', { className: 'dsh-git-success' }, t('settings.saved')) : null,
            ),
        footer: h(React.Fragment, null,
          h('div', { className: 'dsh-git-actions-left' },
            explicit
              ? h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-subtle', disabled: saving || !ready, onClick: reset }, t('session.reset'))
              : null,
          ),
          h('button', { type: 'button', className: 'dsh-git-btn', disabled: saving, onClick: onClose }, t('common.cancel')),
          h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-primary', disabled: saving || !ready, onClick: save },
            saving ? t('settings.saving') : t('session.save')),
        ),
      }),
      missingRepo
        ? h(CreateRepoDialog, {
          missing: missingRepo,
          project: { sessionId },
          store,
          t,
          onCancel: () => setMissingRepo(null),
          onSaveAnyway: () => {
            const target = missingRepo
            setMissingRepo(null)
            void persist({ enabled, repository: target.repository, branch: branch.trim() || defaultBranch }, true)
          },
          onCreated: (repo) => {
            const url = repo.cloneUrl || (repo.htmlUrl ? `${repo.htmlUrl}.git` : '')
            setMissingRepo(null)
            void persist({ enabled, repository: url, branch: branch.trim() || defaultBranch }, true)
          },
        })
        : null,
      )
    }

    /* ------------------------------------------------------------ */
    /* global settings dialog                                       */
    /* ------------------------------------------------------------ */

    function buildSettingsDraft(state) {
      return {
        userName: state && state.global ? state.global.userName || '' : '',
        userEmail: state && state.global ? state.global.userEmail || '' : '',
        requireConfirmation: state && state.global ? state.global.requireConfirmation !== false : true,
        defaultBranch: state && state.global ? state.global.defaultBranch || 'main' : 'main',
        githubPrefix: state && state.global && state.global.githubPrefix ? state.global.githubPrefix : 'https://github.com/',
        askCreateMissingRepo: state && state.global ? state.global.askCreateMissingRepo !== false : true,
        aiProvider: state && state.global ? state.global.aiProvider || '' : '',
        aiModel: state && state.global ? state.global.aiModel || '' : '',
      }
    }

    function SettingsDialog({ store, t, onClose }) {
      const snap = useStore(store)
      const state = snap.state
      const [draft, setDraft] = useState(() => buildSettingsDraft(state))
      const [seeded, setSeeded] = useState(Boolean(state))
      const [token, setToken] = useState('')
      const [clearToken, setClearToken] = useState(false)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)
      const firstInput = useRef(null)
      const focused = useRef(false)
      const initial = useRef(state !== null ? { draft: buildSettingsDraft(state) } : null)

      useEffect(() => {
        if (!snap.loaded) void store.refresh()
      }, [snap.loaded, store])

      useEffect(() => {
        if (state !== null && !seeded) {
          const next = buildSettingsDraft(state)
          setDraft(next)
          initial.current = { draft: next }
          setSeeded(true)
        }
      }, [state, seeded])

      useEffect(() => {
        if (seeded && !focused.current) {
          focused.current = true
          if (firstInput.current) firstInput.current.focus()
        }
      }, [seeded])

      const ready = snap.loaded && state !== null && seeded
      const loadError = !ready && snap.error ? snap.error : null
      const dirty = ready && initial.current !== null && (
        JSON.stringify(draft) !== JSON.stringify(initial.current.draft)
        || token !== ''
        || clearToken
      )
      const githubLogin = state && state.global ? state.global.githubLogin || '' : ''
      const tokenConfigured = Boolean(state && state.tokenConfigured)
      const catalog = snap.aiCatalog || {
        loading: false,
        loaded: false,
        providers: [],
        provider: '',
        models: [],
        selected: null,
        error: null,
      }

      useEffect(() => {
        if (!ready || catalog.loading) return
        if (draft.aiProvider === '') {
          if (!catalog.loaded) void store.loadAiModels('')
        } else if (catalog.provider !== draft.aiProvider) {
          void store.loadAiModels(draft.aiProvider)
        }
      }, [ready, catalog.loaded, catalog.loading, catalog.provider, draft.aiProvider, store])

      const save = async () => {
        setError(null)
        setSaved(false)
        if (!ready) return
        if (draft.aiProvider.trim() !== '' && draft.aiModel.trim() === '') {
          setError(t('settings.aiModelRequired'))
          return
        }
        setSaving(true)
        try {
          const payload = {
            global: {
              userName: draft.userName.trim(),
              userEmail: draft.userEmail.trim(),
              requireConfirmation: draft.requireConfirmation,
              defaultBranch: draft.defaultBranch.trim() || 'main',
              githubPrefix: draft.githubPrefix.trim() || 'https://github.com/',
              askCreateMissingRepo: draft.askCreateMissingRepo,
              aiProvider: draft.aiProvider.trim(),
              aiModel: draft.aiProvider.trim() === '' ? '' : draft.aiModel.trim(),
            },
          }
          if (clearToken) payload.clearToken = true
          else if (token.trim() !== '') payload.token = token.trim()
          const data = await store.saveConfig(payload)
          if (data.githubUserError) {
            setError(`${t('settings.githubUserError')}: ${data.githubUserError}`)
            const next = buildSettingsDraft(data.global ? { ...state, global: data.global } : state)
            setDraft(next)
            initial.current = { draft: next }
            setToken('')
            setClearToken(false)
            return
          }
          initial.current = { draft: JSON.parse(JSON.stringify(draft)) }
          setSaved(true)
          setToken('')
          setClearToken(false)
          setTimeout(() => onClose(), 260)
        } catch (submitError) {
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setSaving(false)
        }
      }

      const loading = !ready && loadError === null

      return h(Modal, {
        title: t('settings.dialogTitle'),
        subtitle: t('settings.dialogSub'),
        onClose,
        closeLabel: t('common.close'),
        guardClose: () => !dirty,
        wide: true,
        children: loading
          ? h('div', { className: 'dsh-git-loading' }, t('common.loading'))
          : !ready
            ? h(React.Fragment, null,
              h('div', { className: 'dsh-git-error' }, loadError || t('common.error')),
              h('div', { style: { marginTop: 12 } },
                h('button', { type: 'button', className: 'dsh-git-btn', onClick: () => { void store.refresh() } }, t('common.retry')),
              ),
            )
            : h(React.Fragment, null,
              h('div', { className: 'dsh-git-section-title' }, t('settings.globalSection')),
              h('div', { style: { height: 10 } }),
              h('div', { className: 'dsh-git-grid2' },
                h(Field, { label: t('settings.userName') }, h('input', {
                  ref: firstInput,
                  className: 'dsh-git-input',
                  'aria-label': t('settings.userName'),
                  value: draft.userName,
                  placeholder: 'Ada Lovelace',
                  spellCheck: false,
                  onChange: (event) => setDraft((current) => ({ ...current, userName: event.target.value })),
                })),
                h(Field, { label: t('settings.userEmail') }, h('input', {
                  className: 'dsh-git-input',
                  'aria-label': t('settings.userEmail'),
                  value: draft.userEmail,
                  placeholder: 'ada@example.com',
                  spellCheck: false,
                  onChange: (event) => setDraft((current) => ({ ...current, userEmail: event.target.value })),
                })),
              ),
              h(Field, {
                label: t('settings.defaultBranch'),
                hint: t('settings.defaultBranchHint'),
              }, h('input', {
                className: 'dsh-git-input',
                'aria-label': t('settings.defaultBranch'),
                value: draft.defaultBranch,
                placeholder: 'main',
                spellCheck: false,
                onChange: (event) => setDraft((current) => ({ ...current, defaultBranch: event.target.value })),
              })),
              h('div', { className: 'dsh-git-switchrow' },
                h('div', { className: 'dsh-git-switchtext' },
                  h('div', { className: 'dsh-git-switchtitle' }, t('settings.confirm')),
                  h('div', { className: 'dsh-git-hint' }, t('settings.confirmHint')),
                ),
                h(Switch, {
                  checked: draft.requireConfirmation,
                  onChange: (value) => setDraft((current) => ({ ...current, requireConfirmation: value })),
                  label: t('settings.confirm'),
                }),
              ),
              h('div', { className: 'dsh-git-section' },
                h('div', { className: 'dsh-git-section-title' }, t('settings.githubSection')),
                h('div', { className: 'dsh-git-hint' },
                  githubLogin !== ''
                    ? t('settings.githubAccountDetected', { login: githubLogin })
                    : t('settings.githubAccountUnknown'),
                ),
                h('div', { style: { height: 10 } }),
                h(Field, {
                  label: t('settings.token'),
                  hint: t('settings.tokenHint'),
                },
                h('input', {
                  className: 'dsh-git-input',
                  'aria-label': t('settings.token'),
                  type: 'password',
                  value: token,
                  autoComplete: 'off',
                  placeholder: t('settings.tokenPlaceholder'),
                  onChange: (event) => {
                    setToken(event.target.value)
                    if (event.target.value !== '') setClearToken(false)
                  },
                }),
                h('div', { className: 'dsh-git-hint' },
                  h('span', { style: { marginRight: 10 } }, tokenConfigured ? t('settings.tokenConfigured') : t('settings.tokenNotConfigured')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-git-btn dsh-git-btn-subtle',
                    style: { minHeight: 24, padding: '0 8px', fontSize: 11, color: clearToken ? 'var(--dsw-alias-state-error-primary)' : undefined },
                    disabled: !tokenConfigured,
                    onClick: () => { setClearToken((value) => !value); setToken('') },
                  }, clearToken ? `✓ ${t('settings.clearToken')}` : t('settings.clearToken')),
                ),
                clearToken ? h('div', { className: 'dsh-git-error' }, t('settings.tokenWillClear')) : null,
                ),
                h(Field, {
                  label: t('settings.githubPrefix'),
                  hint: t('settings.githubPrefixHint'),
                }, h('input', {
                  className: 'dsh-git-input',
                  'aria-label': t('settings.githubPrefix'),
                  value: draft.githubPrefix,
                  placeholder: 'https://github.com/<account>/',
                  spellCheck: false,
                  onChange: (event) => setDraft((current) => ({ ...current, githubPrefix: event.target.value })),
                })),
                h('div', { className: 'dsh-git-switchrow' },
                  h('div', { className: 'dsh-git-switchtext' },
                    h('div', { className: 'dsh-git-switchtitle' }, t('settings.askCreateMissingRepo')),
                    h('div', { className: 'dsh-git-hint' }, t('settings.askCreateMissingRepoHint')),
                  ),
                  h(Switch, {
                    checked: draft.askCreateMissingRepo,
                    onChange: (value) => setDraft((current) => ({ ...current, askCreateMissingRepo: value })),
                    label: t('settings.askCreateMissingRepo'),
                  }),
                ),
              ),
              h('div', { className: 'dsh-git-section' },
                h('div', { className: 'dsh-git-section-title' }, t('settings.aiSection')),
                h('div', { className: 'dsh-git-hint' }, t('settings.aiHint')),
                h('div', { style: { height: 10 } }),
                h(Field, { label: t('settings.aiProvider') }, h('select', {
                  className: 'dsh-git-select',
                  'aria-label': t('settings.aiProvider'),
                  value: draft.aiProvider,
                  onChange: (event) => {
                    const value = event.target.value
                    setDraft((current) => ({ ...current, aiProvider: value, aiModel: '' }))
                    void store.loadAiModels(value)
                  },
                },
                h('option', { value: '' }, t('settings.aiDefault')),
                draft.aiProvider !== '' && !(catalog.providers || []).some((provider) => provider.id === draft.aiProvider)
                  ? h('option', { key: draft.aiProvider, value: draft.aiProvider }, draft.aiProvider)
                  : null,
                (catalog.providers || []).map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name)),
                )),
                h(Field, {
                  label: t('settings.aiModel'),
                  hint: catalog.error
                    ? t('settings.aiLoadFailed', { error: catalog.error })
                    : catalog.loading
                      ? t('settings.aiLoading')
                      : draft.aiProvider !== '' && (catalog.models || []).length === 0
                        ? t('settings.aiNoModels')
                        : null,
                },
                h('select', {
                  className: 'dsh-git-select',
                  'aria-label': t('settings.aiModel'),
                  value: draft.aiModel,
                  disabled: draft.aiProvider === '' || catalog.loading,
                  onChange: (event) => setDraft((current) => ({ ...current, aiModel: event.target.value })),
                },
                h('option', { value: '' }, draft.aiProvider === '' ? t('settings.aiModelDefault') : t('settings.aiModelPlaceholder')),
                draft.aiModel !== '' && !(catalog.models || []).some((model) => model.id === draft.aiModel)
                  ? h('option', { key: draft.aiModel, value: draft.aiModel }, draft.aiModel)
                  : null,
                (catalog.models || []).map((model) => h('option', { key: model.id, value: model.id }, model.name)),
                )),
                h('div', { style: { marginTop: 2 } },
                  h('button', {
                    type: 'button',
                    className: 'dsh-git-btn dsh-git-btn-subtle',
                    style: { minHeight: 24, padding: '0 8px', fontSize: 11 },
                    disabled: catalog.loading,
                    onClick: () => { void store.loadAiModels(draft.aiProvider) },
                  }, t('settings.aiRefresh')),
                ),
              ),
              error ? h('div', { className: 'dsh-git-error', style: { marginTop: 12 } }, error) : null,
              saved ? h('div', { className: 'dsh-git-success', style: { marginTop: 12 } }, t('settings.saved')) : null,
            ),
        footer: h(React.Fragment, null,
          h('div', { className: 'dsh-git-actions-left' }),
          h('button', { type: 'button', className: 'dsh-git-btn', disabled: saving, onClick: onClose }, t('common.cancel')),
          h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-primary', disabled: saving || !ready, onClick: save },
            saving ? t('settings.saving') : t('settings.save')),
        ),
      })
    }

    /* ------------------------------------------------------------ */
    /* GitHub create-repository dialog                              */
    /* ------------------------------------------------------------ */

    function CreateRepoDialog({ missing, project, store, t, onCancel, onCreated, onSaveAnyway }) {
      const [owner, setOwner] = useState(missing.owner || '')
      const [name, setName] = useState(missing.name || '')
      const [description, setDescription] = useState('')
      const [visibility, setVisibility] = useState('private')
      const [autoInit, setAutoInit] = useState(false)
      const [gitignore, setGitignore] = useState('')
      const [license, setLicense] = useState('')
      const [hasIssues, setHasIssues] = useState(true)
      const [hasProjects, setHasProjects] = useState(true)
      const [hasWiki, setHasWiki] = useState(true)
      const [homepage, setHomepage] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [aiBusy, setAiBusy] = useState(false)
      const [aiError, setAiError] = useState(null)
      const firstInput = useRef(null)

      useEffect(() => {
        if (firstInput.current) firstInput.current.focus()
      }, [])

      const generateDescription = async () => {
        setAiBusy(true)
        setAiError(null)
        try {
          const data = await store.describeProject({
            sessionId: project && project.sessionId ? project.sessionId : undefined,
            workspaceId: project && project.workspaceId ? project.workspaceId : undefined,
            language: typeof store.localeId === 'function' ? store.localeId() : 'en',
          })
          setDescription(data.description || '')
        } catch (submitError) {
          setAiError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setAiBusy(false)
        }
      }

      const submit = async () => {
        setError(null)
        if (name.trim() === '') {
          setError(t('repo.nameHint'))
          return
        }
        setBusy(true)
        try {
          const data = await store.createGitHubRepo({
            owner: owner.trim(),
            name: name.trim(),
            description: description.trim(),
            private: visibility === 'private',
            autoInit,
            gitignoreTemplate: gitignore.trim(),
            licenseTemplate: license.trim(),
            hasIssues,
            hasProjects,
            hasWiki,
            homepage: homepage.trim(),
          })
          onCreated(data.repo)
        } catch (submitError) {
          const detail = Array.isArray(submitError && submitError.details)
            ? submitError.details.map((item) => item && item.message).filter(Boolean).join('; ')
            : ''
          setError([submitError && submitError.message ? submitError.message : String(submitError), detail].filter(Boolean).join(' — '))
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: t('repo.createTitle'),
        subtitle: t('repo.createSub'),
        onClose: onCancel,
        closeLabel: t('common.close'),
        wide: true,
        children: h(React.Fragment, null,
          h('div', { className: 'dsh-git-warn' }, t('repo.missingNotice', { repo: missing.htmlUrl || missing.repository })),
          h('div', { style: { height: 12 } }),
          h('div', { className: 'dsh-git-grid2' },
            h(Field, { label: t('repo.owner'), hint: t('repo.ownerHint') }, h('input', {
              className: 'dsh-git-input',
              'aria-label': t('repo.owner'),
              value: owner,
              spellCheck: false,
              onChange: (event) => setOwner(event.target.value),
            })),
            h(Field, { label: t('repo.name'), hint: t('repo.nameHint') }, h('input', {
              ref: firstInput,
              className: 'dsh-git-input',
              'aria-label': t('repo.name'),
              value: name,
              spellCheck: false,
              onChange: (event) => setName(event.target.value),
            })),
          ),
          h('div', { className: 'dsh-git-field' },
            h('div', { className: 'dsh-git-label-row' },
              h('div', { className: 'dsh-git-label' }, t('repo.description')),
              h('button', {
                type: 'button',
                className: 'dsh-git-btn dsh-git-btn-subtle dsh-git-ai-btn',
                disabled: aiBusy,
                onClick: () => { void generateDescription() },
              }, aiBusy ? t('repo.aiDescribing') : t('repo.aiDescribe')),
            ),
            h('textarea', {
              className: 'dsh-git-textarea',
              'aria-label': t('repo.description'),
              style: { minHeight: 60 },
              value: description,
              spellCheck: false,
              onChange: (event) => setDescription(event.target.value),
            }),
            aiError ? h('div', { className: 'dsh-git-error' }, aiError) : null,
            h('div', { className: 'dsh-git-hint' }, t('repo.aiHint')),
          ),
          h('div', { className: 'dsh-git-grid2' },
            h(Field, { label: t('repo.visibility') }, h('select', {
              className: 'dsh-git-select',
              'aria-label': t('repo.visibility'),
              value: visibility,
              onChange: (event) => setVisibility(event.target.value),
            },
            h('option', { value: 'private' }, t('repo.private')),
            h('option', { value: 'public' }, t('repo.public')),
            )),
            h(Field, { label: t('repo.homepage') }, h('input', {
              className: 'dsh-git-input',
              'aria-label': t('repo.homepage'),
              value: homepage,
              placeholder: 'https://example.com',
              spellCheck: false,
              onChange: (event) => setHomepage(event.target.value),
            })),
          ),
          h('div', { className: 'dsh-git-checkgrid' },
            h('label', { className: 'dsh-git-checkrow' },
              h('input', { type: 'checkbox', checked: autoInit, onChange: (event) => setAutoInit(event.target.checked) }),
              h('span', null, t('repo.autoInit')),
            ),
            h('label', { className: 'dsh-git-checkrow' },
              h('input', { type: 'checkbox', checked: hasIssues, onChange: (event) => setHasIssues(event.target.checked) }),
              h('span', null, t('repo.hasIssues')),
            ),
            h('label', { className: 'dsh-git-checkrow' },
              h('input', { type: 'checkbox', checked: hasProjects, onChange: (event) => setHasProjects(event.target.checked) }),
              h('span', null, t('repo.hasProjects')),
            ),
            h('label', { className: 'dsh-git-checkrow' },
              h('input', { type: 'checkbox', checked: hasWiki, onChange: (event) => setHasWiki(event.target.checked) }),
              h('span', null, t('repo.hasWiki')),
            ),
          ),
          h('div', { className: 'dsh-git-hint' }, t('repo.autoInitHint')),
          h('div', { style: { height: 8 } }),
          h('div', { className: 'dsh-git-grid2' },
            h(Field, { label: t('repo.gitignore'), hint: t('repo.optionalHint') }, h('input', {
              className: 'dsh-git-input',
              'aria-label': t('repo.gitignore'),
              value: gitignore,
              placeholder: 'Node',
              spellCheck: false,
              onChange: (event) => setGitignore(event.target.value),
            })),
            h(Field, { label: t('repo.license'), hint: t('repo.optionalHint') }, h('input', {
              className: 'dsh-git-input',
              'aria-label': t('repo.license'),
              value: license,
              placeholder: 'MIT',
              spellCheck: false,
              onChange: (event) => setLicense(event.target.value),
            })),
          ),
          error ? h('div', { className: 'dsh-git-error', style: { marginTop: 10 } }, error) : null,
        ),
        footer: h(React.Fragment, null,
          h('div', { className: 'dsh-git-actions-left' },
            typeof onSaveAnyway === 'function'
              ? h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-subtle', disabled: busy, onClick: onSaveAnyway }, t('repo.saveAnyway'))
              : null,
          ),
          h('button', { type: 'button', className: 'dsh-git-btn', disabled: busy, onClick: onCancel }, t('repo.back')),
          h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-primary', disabled: busy || aiBusy, onClick: submit },
            busy ? t('repo.creating') : t('repo.create')),
        ),
      })
    }

    /* ------------------------------------------------------------ */
    /* workspace dialog                                             */
    /* ------------------------------------------------------------ */

    function WorkspaceGitDialog({ workspaceId, displayTitle, store, t, onClose }) {
      const snap = useStore(store)
      const workspace = snap.state && Array.isArray(snap.state.workspaces)
        ? snap.state.workspaces.find((item) => item.id === workspaceId)
        : undefined
      const config = workspace && workspace.config ? workspace.config : null
      const defaultBranch = snap.state && snap.state.global ? snap.state.global.defaultBranch || 'main' : 'main'
      const [enabled, setEnabled] = useState(Boolean(config && config.enabled))
      const [repository, setRepository] = useState(config && config.repository ? config.repository : '')
      const [branch, setBranch] = useState(config && config.branch ? config.branch : defaultBranch)
      const [seeded, setSeeded] = useState(Boolean(config))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)
      const [warning, setWarning] = useState(null)
      const [missingRepo, setMissingRepo] = useState(null)
      const firstInput = useRef(null)
      const focused = useRef(false)
      const initial = useRef(config
        ? {
          enabled: Boolean(config.enabled),
          repository: config.repository || '',
          branch: config.branch || defaultBranch,
        }
        : null)

      useEffect(() => {
        if (!snap.loaded) void store.refresh()
      }, [snap.loaded, store])

      useEffect(() => {
        if (workspace && !seeded) {
          const values = {
            enabled: Boolean(config && config.enabled),
            repository: config && config.repository ? config.repository : '',
            branch: config && config.branch ? config.branch : defaultBranch,
          }
          setEnabled(values.enabled)
          setRepository(values.repository)
          setBranch(values.branch)
          initial.current = values
          setSeeded(true)
        }
      }, [workspace, config, seeded, defaultBranch])

      useEffect(() => {
        if (seeded && !focused.current) {
          focused.current = true
          if (firstInput.current) firstInput.current.focus()
        }
      }, [seeded])

      const ready = snap.loaded && workspace !== undefined
      const loadError = !ready ? (snap.error || (snap.loaded ? t('workspace.notFound') : null)) : null
      const dirty = ready && initial.current !== null && (
        enabled !== initial.current.enabled
        || repository !== initial.current.repository
        || branch !== initial.current.branch
      )

      const persist = async (values, skipRepoCheck) => {
        setSaving(true)
        setError(null)
        setWarning(null)
        setSaved(false)
        try {
          const data = await store.saveWorkspace(workspaceId, {
            ...values,
            skipRepoCheck: skipRepoCheck === true,
          })
          initial.current = { ...values }
          setSeeded(true)
          setSaved(true)
          if (data.repoCheckWarning) setWarning(data.repoCheckWarning)
          setTimeout(() => onClose(), 320)
        } catch (submitError) {
          if (submitError && submitError.code === 'REPO_NOT_FOUND' && submitError.details) {
            setMissingRepo(submitError.details)
            return
          }
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setSaving(false)
        }
      }

      const save = () => {
        if (enabled && repository.trim() === '') {
          setError(t('session.repoRequired'))
          return
        }
        void persist({
          enabled,
          repository: repository.trim(),
          branch: branch.trim() || defaultBranch,
        }, false)
      }

      const reset = async () => {
        setSaving(true)
        setError(null)
        try {
          await store.saveWorkspace(workspaceId, { reset: true })
          onClose()
        } catch (submitError) {
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setSaving(false)
        }
      }

      const title = displayTitle && displayTitle !== '' ? displayTitle : (workspace ? workspace.title : t('workspace.dialogTitle'))
      const loading = !ready && loadError === null

      return h(React.Fragment, null,
        h(Modal, {
          title: t('workspace.dialogTitle'),
          subtitle: `${title} · ${t('workspace.dialogSub')}`,
          onClose,
          closeLabel: t('common.close'),
          guardClose: () => !dirty,
          children: loading
            ? h('div', { className: 'dsh-git-loading' }, t('common.loading'))
            : !ready
              ? h(React.Fragment, null,
                h('div', { className: 'dsh-git-error' }, loadError || t('common.error')),
                h('div', { style: { marginTop: 12 } },
                  h('button', { type: 'button', className: 'dsh-git-btn', onClick: () => { void store.refresh() } }, t('common.retry')),
                ),
              )
              : h(React.Fragment, null,
                h('div', { className: 'dsh-git-switchrow' },
                  h('div', { className: 'dsh-git-switchtext' },
                    h('div', { className: 'dsh-git-switchtitle' }, t('workspace.enabled')),
                    h('div', { className: 'dsh-git-hint' }, t('workspace.hint')),
                  ),
                  h(Switch, { checked: enabled, onChange: setEnabled, label: t('workspace.enabled') }),
                ),
                h(Field, { label: t('workspace.repository'), hint: t('session.repositoryHint') }, h('input', {
                  ref: firstInput,
                  className: 'dsh-git-input',
                  'aria-label': t('workspace.repository'),
                  value: repository,
                  placeholder: t('session.repositoryPlaceholder'),
                  spellCheck: false,
                  onChange: (event) => setRepository(event.target.value),
                })),
                h(Field, { label: t('workspace.branch') }, h('input', {
                  className: 'dsh-git-input',
                  'aria-label': t('workspace.branch'),
                  value: branch,
                  placeholder: defaultBranch,
                  spellCheck: false,
                  onChange: (event) => setBranch(event.target.value),
                })),
                workspace ? h('div', { className: 'dsh-git-hint' }, workspace.path) : null,
                h('div', { className: 'dsh-git-hint' }, t('workspace.dialogSub')),
                warning ? h('div', { className: 'dsh-git-warn' }, warning) : null,
                error ? h('div', { className: 'dsh-git-error' }, error) : null,
                saved ? h('div', { className: 'dsh-git-success' }, t('settings.saved')) : null,
              ),
          footer: h(React.Fragment, null,
            h('div', { className: 'dsh-git-actions-left' },
              config !== null
                ? h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-subtle', disabled: saving || !ready, onClick: reset }, t('workspace.reset'))
                : null,
            ),
            h('button', { type: 'button', className: 'dsh-git-btn', disabled: saving, onClick: onClose }, t('common.cancel')),
            h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-primary', disabled: saving || !ready, onClick: save },
              saving ? t('settings.saving') : t('workspace.save')),
          ),
        }),
        missingRepo
          ? h(CreateRepoDialog, {
            missing: missingRepo,
            project: { workspaceId },
            store,
            t,
            onCancel: () => setMissingRepo(null),
            onSaveAnyway: () => {
              const target = missingRepo
              setMissingRepo(null)
              void persist({ enabled, repository: target.repository, branch: branch.trim() || defaultBranch }, true)
            },
            onCreated: (repo) => {
              const url = repo.cloneUrl || (repo.htmlUrl ? `${repo.htmlUrl}.git` : '')
              setMissingRepo(null)
              void persist({ enabled, repository: url, branch: branch.trim() || defaultBranch }, true)
            },
          })
          : null,
      )
    }

    /* ------------------------------------------------------------ */
    /* session-row button + HOC settings button                     */
    /* ------------------------------------------------------------ */

    function SessionGitButton({ sessionId, displayTitle, store, t }) {
      const snap = useStore(store)
      useEffect(() => {
        void store.ensureSession(sessionId)
      }, [store, sessionId])
      const inline = snap.state && snap.state.sessions ? snap.state.sessions[sessionId] : undefined
      const config = snap.sessionConfigs[sessionId] || inline
      const enabled = Boolean(config && config.enabled)
      const pendingCount = snap.state && Array.isArray(snap.state.pending)
        ? snap.state.pending.filter((item) => item.sessionId === sessionId).length
        : 0
      const title = `${t('session.actionTitle')} · ${enabled ? t('session.on') : t('session.off')}${pendingCount > 0 ? ` · ${t('settings.pendingCount', { n: pendingCount })}` : ''}`
      const rowTitle = displayTitle && displayTitle !== '' ? displayTitle : t('session.untitled')
      return h('button', {
        type: 'button',
        className: 'dsh-git-rowbtn',
        'data-enabled': enabled ? 'true' : 'false',
        title,
        'aria-label': title,
        onClick: (event) => {
          event.stopPropagation()
          store.openSessionDialog(sessionId, rowTitle)
        },
      }, h(BranchIcon, { size: 14 }), enabled ? h('span', { className: 'dsh-git-on-dot' }) : null)
    }

    function SessionGitMenuItem({ sessionId, displayTitle, store, t, useMenuOpenState }) {
      const snap = useStore(store)
      const menuOpenState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      useEffect(() => {
        void store.ensureSession(sessionId)
      }, [store, sessionId])
      const inline = snap.state && snap.state.sessions ? snap.state.sessions[sessionId] : undefined
      const config = snap.sessionConfigs[sessionId] || inline
      const enabled = Boolean(config && config.enabled)
      const openDialog = () => {
        if (Array.isArray(menuOpenState) && typeof menuOpenState[1] === 'function') menuOpenState[1](false)
        store.openSessionDialog(sessionId, displayTitle)
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-git-menuitem',
        onClick: openDialog,
      },
      h(BranchIcon, { size: 14 }),
      h('span', null, `${t('session.menuItem')} · ${enabled ? t('session.on') : t('session.off')}`),
      )
    }

    function SessionGitTrailing({ sessionId, store, t }) {
      const snap = useStore(store)
      useEffect(() => {
        void store.ensureSession(sessionId)
      }, [store, sessionId])
      const inline = snap.state && snap.state.sessions ? snap.state.sessions[sessionId] : undefined
      const config = snap.sessionConfigs[sessionId] || inline
      const enabled = Boolean(config && config.enabled)
      const pending = snap.state && Array.isArray(snap.state.pending)
        ? snap.state.pending.some((item) => item.sessionId === sessionId)
        : false
      if (!enabled && !pending) return null
      const label = pending ? t('session.pending') : t('session.on')
      return h('span', {
        className: 'dsh-git-trailing',
        role: 'img',
        'data-pending': pending ? 'true' : 'false',
        title: label,
        'aria-label': label,
      }, h(BranchIcon, { size: 11 }))
    }

    function NewSessionGitButton(props) {
      const { store, t } = props
      const snap = useStore(store)
      const [open, setOpen] = useState(false)
      const pendingCount = snap.state && Array.isArray(snap.state.pending) ? snap.state.pending.length : 0
      if (props.wide !== true) return props.children
      const title = pendingCount > 0
        ? `${t('settings.buttonTitle')} · ${t('settings.pendingCount', { n: pendingCount })}`
        : t('settings.buttonTitle')
      return h(React.Fragment, null,
        props.children,
        h('button', {
          type: 'button',
          className: 'dsh-git-newbtn',
          title,
          'aria-label': title,
          onClick: () => setOpen(true),
        }, h(GearIcon, { size: 16 }), pendingCount > 0 ? h('span', { className: 'dsh-git-badge', 'aria-hidden': 'true' }) : null),
        open ? h(SettingsDialog, { store, t, onClose: () => setOpen(false) }) : null,
      )
    }

    /* ------------------------------------------------------------ */
    /* pending confirmation modal                                   */
    /* ------------------------------------------------------------ */

    function PendingDialog({ store, t }) {
      const snap = useStore(store)
      const pending = snap.state && Array.isArray(snap.state.pending) ? snap.state.pending[0] : undefined
      const pendingId = pending ? pending.id : null
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const [submitted, setSubmitted] = useState(false)
      const [error, setError] = useState(null)
      const textareaRef = useRef(null)
      const focusedId = useRef(null)

      useEffect(() => {
        if (pending) {
          setMessage(pending.message || '')
          setError(null)
          setSubmitted(false)
        }
      }, [pendingId])

      useEffect(() => {
        if (pending && focusedId.current !== pending.id) {
          focusedId.current = pending.id
          if (textareaRef.current) textareaRef.current.focus()
        }
      }, [pendingId, pending])

      if (!pending) return null
      const title = pending.sessionTitle && pending.sessionTitle !== '' ? pending.sessionTitle : t('session.untitled')
      const files = Array.isArray(pending.files) ? pending.files : []
      const commit = async () => {
        setError(null)
        if (message.trim() === '') {
          setError(t('confirm.emptyMessage'))
          return
        }
        setBusy(true)
        try {
          const data = await store.decide(pending.id, 'commit', message)
          setSubmitted(true)
          const result = data && data.result
          if (result && (result.status === 'commit-failed' || result.status === 'push-failed')) {
            setError([result.error, result.recovery].filter(Boolean).join('\n') || t('toast.commitFailed'))
            return
          }
        } catch (submitError) {
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setBusy(false)
        }
      }
      const skip = async () => {
        setBusy(true)
        setError(null)
        try {
          await store.decide(pending.id, 'cancel')
          setSubmitted(true)
        } catch (submitError) {
          setError(submitError && submitError.message ? submitError.message : String(submitError))
        } finally {
          setBusy(false)
        }
      }
      return h(Modal, {
        title: t('confirm.title'),
        subtitle: t('confirm.sub'),
        wide: true,
        children: h(React.Fragment, null,
          h('div', { className: 'dsh-git-kv' },
            h('div', { className: 'dsh-git-k' }, t('confirm.session')),
            h('div', { className: 'dsh-git-v' }, title),
            h('div', { className: 'dsh-git-k' }, t('confirm.repository')),
            h('div', { className: 'dsh-git-v' }, repoLabel(pending.repository)),
            h('div', { className: 'dsh-git-k' }, t('confirm.branch')),
            h('div', { className: 'dsh-git-v' }, pending.branch || 'main'),
          ),
          h('div', { className: 'dsh-git-label', style: { marginBottom: 4 } }, t('confirm.files', { n: pending.fileCount || files.length })),
          h('div', { className: 'dsh-git-filebox' },
            files.slice(0, 40).map((file) => h('div', { key: file, title: file }, file)),
            (pending.fileCount || 0) > 40 ? h('div', null, t('confirm.moreFiles', { n: (pending.fileCount || 0) - 40 })) : null,
          ),
          h('div', { className: 'dsh-git-hint' }, t('confirm.filesHint')),
          h('div', { style: { height: 14 } }),
          h(Field, {
            label: t('confirm.message'),
            hint: t('confirm.messageHint'),
          }, h('textarea', {
            ref: textareaRef,
            className: 'dsh-git-textarea',
            'aria-label': t('confirm.message'),
            value: message,
            spellCheck: false,
            onChange: (event) => setMessage(event.target.value),
          })),
          pending.stat ? h('div', { className: 'dsh-git-hint', style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--ds-font-family-code,monospace)' } }, pending.stat) : null,
          error ? h('div', { className: 'dsh-git-error', style: { marginTop: 10, whiteSpace: 'pre-wrap' } }, error) : null,
        ),
        footer: h(React.Fragment, null,
          h('div', { className: 'dsh-git-actions-left' },
            h('span', { className: 'dsh-git-hint' }, t('confirm.skipHint')),
          ),
          h('button', { type: 'button', className: 'dsh-git-btn', disabled: busy || submitted, onClick: skip }, t('confirm.skip')),
          h('button', { type: 'button', className: 'dsh-git-btn dsh-git-btn-primary', disabled: busy || submitted, onClick: commit },
            busy ? t('confirm.working') : t('confirm.commit')),
        ),
      })
    }

    /* ------------------------------------------------------------ */
    /* toast                                                        */
    /* ------------------------------------------------------------ */

    function toastText(result, t) {
      const error = result.error ? String(result.error) : ''
      const recovery = result.recovery ? String(result.recovery) : ''
      const detail = [error, recovery].filter(Boolean).join('\n')
      switch (result.status) {
        case 'pushed': return { tone: 'success', title: t('toast.pushed', { repo: repoLabel(result.repository) }) }
        case 'committed': return { tone: 'warn', title: t('toast.committed') }
        case 'push-failed': return { tone: 'warn', title: t('toast.pushFailedTitle'), detail }
        case 'commit-failed': return { tone: 'error', title: t('toast.commitFailed'), detail }
        case 'cancelled': return { tone: 'warn', title: t('toast.cancelled') }
        case 'error': return { tone: 'error', title: t('toast.error'), detail }
        default: return null
      }
    }

    function ToastHost({ store, t }) {
      const snap = useStore(store)
      const [toast, setToast] = useState(null)
      const seen = useRef(null)
      const timer = useRef(null)
      const results = snap.state && Array.isArray(snap.state.lastResults) ? snap.state.lastResults : []
      useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])
      useEffect(() => {
        if (seen.current === null) {
          seen.current = new Set(results.map((item) => item.id))
          return undefined
        }
        const fresh = results.filter((item) => !seen.current.has(item.id))
        if (fresh.length === 0) return undefined
        for (const item of fresh) seen.current.add(item.id)
        setToast(fresh[0])
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = null
          setToast(null)
        }, 7000)
        return undefined
      }, [results])
      if (!toast) return null
      const view = toastText(toast, t)
      if (!view) return null
      const dismiss = () => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        setToast(null)
      }
      return ReactDOM.createPortal(h('div', { className: 'dsh-git-toast', 'data-tone': view.tone, role: 'status' },
        h('div', { className: 'dsh-git-toast-body' },
          h('div', { className: 'dsh-git-toast-title' }, view.title),
          view.detail ? h('div', { className: 'dsh-git-toast-detail' }, view.detail) : null,
        ),
        h('button', { type: 'button', className: 'dsh-git-toast-close', 'aria-label': t('common.close'), onClick: dismiss }, '×'),
      ), document.body)
    }

    function OverlayHost({ store, t }) {
      const snap = useStore(store)
      const dialog = snap.dialog
      const workspaceDialog = snap.workspaceDialog
      return h(React.Fragment, null,
        dialog
          ? h(SessionGitDialog, {
            key: dialog.sessionId,
            sessionId: dialog.sessionId,
            displayTitle: dialog.displayTitle,
            store,
            t,
            onClose: () => store.closeSessionDialog(),
          })
          : null,
        workspaceDialog
          ? h(WorkspaceGitDialog, {
            key: workspaceDialog.workspaceId,
            workspaceId: workspaceDialog.workspaceId,
            displayTitle: workspaceDialog.displayTitle,
            store,
            t,
            onClose: () => store.closeWorkspaceDialog(),
          })
          : null,
        h(PendingDialog, { store, t }),
        h(ToastHost, { store, t }),
      )
    }

    /* ------------------------------------------------------------ */
    /* plugin                                                       */
    /* ------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`)
        const t = ctx.locale.bind(NS)
        const store = createStore(() => {
          try {
            return ctx.locale.getLocale().active
          } catch {
            return 'en'
          }
        })

        ctx.effect(() => ctx.contextMenus.register({
          id: 'workspace.git',
          target: 'workspace',
          order: 250,
          resolve: (target) => {
            const snapshot = store.get()
            const workspace = snapshot.state && Array.isArray(snapshot.state.workspaces)
              ? snapshot.state.workspaces.find((item) => item.id === target.workspaceId)
              : undefined
            const enabled = Boolean(workspace && workspace.config && workspace.config.enabled)
            return [{
              id: 'git-auto-commit',
              label: enabled ? `${t('workspace.menuItem')} · ${t('session.on')}` : t('workspace.menuItem'),
              icon: { key: 'workspace.git' },
              run: () => store.openWorkspaceDialog(target.workspaceId, target.displayTitle),
            }]
          },
        }), `${NS}: workspace menu`)

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: 'workspace.git',
          locale: NS,
        }, () => h(BranchIcon, { size: 14 })))

        ctx.effect(() => {
          const element = document.createElement('style')
          element.dataset.plugin = NS
          element.textContent = CSS
          document.head.appendChild(element)
          return () => element.remove()
        }, `${NS}: styles`)

        ctx.effect(() => {
          store.start()
          return () => store.stop()
        }, `${NS}: polling`)

        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'git-auto-commit',
          order: 150,
          locale: NS,
        }, (props) => h(SessionGitButton, { ...props, store, t })))

        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'git-auto-commit-trailing',
          order: 40,
          locale: NS,
        }, (props) => h(SessionGitTrailing, { ...props, store, t })))

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'git-auto-commit-menu',
          order: 120,
          locale: NS,
        }, (props) => h(SessionGitMenuItem, { ...props, store, t })))

        ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
          name: 'sidebar.session.action',
          id: 'git-auto-commit-settings',
          order: 50,
          locale: NS,
        }, (props) => h(NewSessionGitButton, { ...props, store, t })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'git-auto-commit-overlay',
          order: 900,
          locale: NS,
        }, () => h(OverlayHost, { store, t })))
      },
    }
  },
})
