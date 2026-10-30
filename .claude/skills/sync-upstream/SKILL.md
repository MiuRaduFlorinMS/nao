---
allowed-tools: Bash(git status*), Bash(git fetch*), Bash(git log*), Bash(git diff*), Bash(git branch*), Bash(git checkout*), Bash(git pull --ff-only origin main), Bash(git merge upstream/main*), Bash(git add*), Bash(git commit*), Bash(git push -u origin sync-upstream-main-*), Bash(npm run *), Bash(npx npm@11.10.1 *), Bash(uvx ruff@0.15.7 *), Bash(df -h*), Bash(bun install --lockfile-only), Bash(source ~/.nvm/nvm.sh*)
description: Merge upstream getnao/nao into a new sync-upstream-main-N branch of the fork, resolve conflicts, report, and push the branch
---

Sync the fork (`origin` = MiuRaduFlorinMS/nao) with `upstream` (getnao/nao).

**Hard rules**

- All upstream work happens on a new `sync-upstream-main-N` branch. Never commit on `main`, never merge the sync branch into `main`, never open or merge the PR. The user merges the branch into main themselves.
- `main` is only fast-forwarded from `origin`, never from `upstream`.
- Never force-push. Never push to `main`.
- `--no-verify` is allowed only for the mysqlclient hook failure described in step 7.

## 1. Preflight

- The repo is engine-strict and upstream bumps the Node pin from time to time, so re-check it **after the merge** (step 5) from `.nvmrc`, not before.
- `git status` must be clean apart from untracked files. If there are uncommitted changes to tracked files, stop and report.
- `df -h .` — if less than 5 GB free, warn the user before continuing (npm ci and uv need room).

## 2. Fetch and assess

```bash
git checkout main && git pull --ff-only origin main && git fetch upstream
git log --oneline main..upstream/main
```

- If the log is empty, report "already up to date" and stop.
- Tell the user if local `main` is ahead of `origin/main` (`git log --oneline origin/main..main`): those unpushed commits will ride along in the sync branch.
- Pick the next unused `N` from `git branch -a | grep sync-upstream-main` (the first sync used `sync-upstream-main`, then `-2`, …) and run `git checkout -b sync-upstream-main-N`.

## 3. Merge

- Confirm `git branch --show-current` is the sync branch.
- `git merge upstream/main --no-ff --no-commit`
- List conflicts: `git diff --name-only --diff-filter=U`

## 4. Resolve conflicts

Defaults:

- Take upstream for code the fork has not customized.
- Combine both sides when both add things (imports, union types, config fields, list entries).

Always preserve these fork customizations:

- `.github/workflows/docker.yml` — keep the fork's GHCR publishing version (`git checkout --ours`). Upstream's Docker Hub description step and its `deploy` / `deploy-cloud` jobs target nao's own servers and must not come back.
- MCP `auth` with `gcp-id-token` in `apps/shared` MCP types, kept alongside upstream's `oauth`; in backend `mcp.ts`, `_ensureOAuthFlag` must skip configs where `config.auth?.type === 'gcp-id-token'`.
- Gemini output budget: `GEMINI_MAX_OUTPUT_TOKENS` and the provider-aware default in `apps/backend/src/services/agent.ts`; `GEMINI_OUTPUT_RESERVE` and the google/vertex branch of `fitThinkingBudget` in `apps/backend/src/agents/providers.ts`.
- The `google-auth-library` dependency — check it is still in `package.json` and `package-lock.json` after resolving.
- Output-limit continuation (answers cut off by the output token cap keep going in the same message):
    - `apps/backend/src/agents/length-continuation.ts` (fork-only file) with `streamWithLengthContinuations`, `MAX_LENGTH_CONTINUATIONS` and `LENGTH_CONTINUATION_PROMPT`.
    - In `AgentManager.stream()` (`apps/backend/src/services/agent.ts`), `execute` must call `streamWithLengthContinuations` instead of a single `this._agent.stream(...)` + `writer.merge(result.toUIMessageStream(...))`. Memory extraction and title generation run once from `_scheduleRequestSideTasks` on the first result. `_getTotalUsage` takes the `results` array and sums it with `sumTokenUsage` (`apps/backend/src/utils/ai.ts`). If upstream rewrites `stream()`, re-apply the loop on top of their version rather than taking theirs as is.
    - Frontend fallback: `apps/frontend/src/components/chat-messages/truncated-answer-notice.tsx` (fork-only), mounted next to `<ChatError />` in `chat-messages.tsx`. It relies on `stopReason` still being returned on `UIMessage` by `chat.get`.
    - Test: `apps/backend/tests/length-continuation.test.ts` must still pass.
- `CLOUD_GITHUB_PROJECT_*` validation in `apps/backend/src/env.ts`: the fork requires these four variables only when at least one is set, never just because `NAO_MODE=cloud` (the fork's Cloud Run deployment runs in cloud mode without nao's GitHub App and crash-loops otherwise). Keep `apps/backend/tests/managed-github-env.test.ts` in line with that.
- New upstream env vars made **required** for `NAO_MODE=cloud` (look for `required when NAO_MODE=cloud` in `env.ts` after the merge): flag them in the report, since they will crash the fork's cloud-mode deployment unless set in Cloud Run or relaxed like the GitHub ones.

Workflows the fork deliberately deleted — keep them deleted. They deploy to nao's own infrastructure or gate outside contributors, so they only fail or do nothing in the fork:

- `.github/workflows/approve-contributor.yml`, `caddy.yml`, `cloud-preprod.yml`, `issue-gate.yml`, `pr-gate.yml`, `pr-preview.yml`, `publish.yml`, `remove-old-artifacts.yml`.
- A modify/delete conflict on any of them → `git rm` it. After the merge, also `git rm` any of them that upstream added back or newly introduced (check `ls .github/workflows`).
- Any other **new** upstream workflow: flag it in the report, and recommend deleting it if it targets nao's infrastructure (getnao.io domains, the `nao-previews` GCP project, `VM_HOST` / `PRIVATE_KEY` secrets, PyPI or Docker Hub publishing).

Lockfiles — never hand-merge:

- `package-lock.json`: `git checkout --theirs package-lock.json`, then `npx npm@11.10.1 install --package-lock-only --ignore-scripts --no-audit --no-fund` so fork-only dependencies are added back.
- `bun.lock`: take upstream's, then `bun install --lockfile-only`. Do not run a full `bun install` (it leaves duplicate packages in `node_modules`).

If a conflict is ambiguous (fork logic and an upstream rewrite genuinely clash), stop and ask the user, with a recommendation, instead of guessing.

Stage each resolved file with `git add`.

## 5. Verify

Set up the Node toolchain pinned by the merged `.nvmrc` and `package.json` `engines`:

```bash
NODE_VERSION=$(cat .nvmrc | tr -d v)
source ~/.nvm/nvm.sh && nvm install "$NODE_VERSION"   # no-op if already installed
export PATH=$HOME/.nvm/versions/node/v$NODE_VERSION/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=8192          # frontend tsc runs out of memory otherwise
npm -v   # must match engines.npm (11.10.1); if not: npm i -g npm@11.10.1
```

Export these in every shell command that runs npm, node, or `git commit` (the hook needs them too). Run them in this order:

```bash
rm -rf node_modules apps/backend/node_modules apps/frontend/node_modules apps/shared/node_modules   # no globs: zsh aborts on unmatched globs
npx npm@11.10.1 ci
npm run lock:check
npm run lint
npm run format:check
npm run db:check-migrations -w @nao/backend
cd cli && uvx ruff@0.15.7 check && uvx ruff@0.15.7 check --select I . && uvx ruff@0.15.7 format --check
```

- Use the pinned ruff 0.15.7; newer ruff versions report hundreds of false errors.
- Skip `uv run ty check`: it cannot build `mysqlclient` on this machine.
- Fix real failures and re-run until everything passes.

## 6. Report

Before committing, give the user:

1. A conflict table: file | what conflicted | resolution (ours / theirs / combined) | why.
2. A short upstream changelog from `git log --oneline main..upstream/main`, grouped into features / fixes / chores.
3. Verification results for each check in step 5.

## 7. Commit

```bash
git commit -m "Merge remote-tracking branch 'upstream/main' into sync-upstream-main-N"
```

End the message with the Co-Authored-By trailer.

If the hook fails, read the error:

- If it is **specifically** the `uv run ty check` failure (`Failed to build mysqlclient`, `pkg-config: command not found`), re-run the same commit with `--no-verify`. Step 5 already ran every other check.
- Any other failure: fix it and commit again. Do not bypass.

## 8. Push and hand off

```bash
git push -u origin sync-upstream-main-N
```

`gh` is not installed. Print the PR link `https://github.com/MiuRaduFlorinMS/nao/compare/main...sync-upstream-main-N?expand=1`, plus a ready-to-paste PR title and body (the step 6 report).

Then stop. The user merges the branch into `main`.
