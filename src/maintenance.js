import { findRepoRoot, git, removeManagedWorktree } from './git.js';
import { indexMission, loadMission, saveMission } from './state.js';

export async function cleanupMissionWorktrees(options = {}) {
  const repoRoot = await findRepoRoot(options.repoRoot ?? process.cwd());
  const mission = await loadMission(repoRoot, options.missionId ?? 'latest');
  if (!mission) throw new Error('No mission found.');
  const paths = [...new Set((mission.candidates ?? []).map((candidate) => candidate.worktreePath).filter(Boolean))];
  const removed = [];
  const skipped = [];
  for (const worktreePath of paths) {
    try {
      const ok = await removeManagedWorktree(repoRoot, worktreePath, { force: options.force === true, allowFailure: true });
      if (ok) removed.push(worktreePath);
      else skipped.push({ worktreePath, reason: 'Git refused to remove the worktree; use --force after confirming its sealed patch is stored.' });
    } catch (error) {
      skipped.push({ worktreePath, reason: error.message });
    }
  }
  await git(['worktree', 'prune'], { cwd: repoRoot, allowFailure: true });
  const removedSet = new Set(removed);
  for (const candidate of mission.candidates ?? []) {
    if (removedSet.has(candidate.worktreePath)) candidate.worktreeRetained = false;
  }
  mission.maintenance = { cleanedAt: new Date().toISOString(), removed: removed.length, skipped: skipped.length };
  await saveMission(repoRoot, mission);
  await indexMission(repoRoot, mission);
  return { missionId: mission.id, removed, skipped };
}
