import { actions, adapter } from './store';

/** Opens a repository through the control plane when it is attached; the standalone design preview has none. */
export async function openRepository(): Promise<boolean> {
  if (adapter?.openRepository) {
    try { return await adapter.openRepository(); } catch (e) { actions().toast({ tone: 'danger', title: 'Could not open the repository', body: (e as Error).message }); return false; }
  }
  actions().toast({ tone: 'info', title: 'Design preview', body: 'This screen shows sample data. Open repositories from Projects in the live app.' });
  return false;
}
