// ADR 0017 through the real app: a provider key (a fake one, exported like a user would) makes that provider's
// models choosable per tier in Settings and per mission; keys never reach the renderer; malformed choices are refused.
// No model is called: nothing here plans or runs a mission with Pi.
import { expect, test } from '@playwright/test';
import { sampleRepo } from '../helpers';
import { launch } from './app';

const KEY = 'sk-mistral-e2e-test-key-0000';

test('providers and models: choose per tier in Settings and per mission', async () => {
  const { app, page } = await launch({ openDir: sampleRepo(), env: { MISTRAL_API_KEY: KEY } });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'Settings' }).first().click();

    // The key from the environment is shown as configured, never as text.
    const providers = page.getByTestId('providers');
    await expect(providers).toContainText('Mistral');
    await expect(providers).toContainText('from MISTRAL_API_KEY');
    const add = page.getByTestId('provider-add');
    await expect(add.locator('option', { hasText: 'Groq' })).toHaveCount(1);
    await expect(add.locator('option', { hasText: 'Mistral' })).toHaveCount(0);

    // Only Mistral's models are offered; choose a default and a strong model.
    const models = page.getByTestId('models');
    await expect(models).toContainText('configured provider');
    const def = page.getByTestId('model-default');
    const refs = await def.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(refs.length).toBeGreaterThan(3);
    expect(refs.every((r) => r.startsWith('mistral/'))).toBe(true);
    await def.selectOption(refs[0]);
    await page.getByTestId('model-strong').selectOption(refs[1]);
    await expect(def).toHaveValue(refs[0]);

    const state = await page.evaluate(async () => {
      const a = (window as any).atlas;
      const s = await a.invoke('settings.get', {});
      const creds = await a.invoke('credentials.list', {});
      let rejected = '';
      try { await a.invoke('settings.set', { key: 'models.default', value: 'not a model ref' }); } catch (e) { rejected = (e as Error).message; }
      let rejectedMission = '';
      const [ws] = await a.invoke('workspace.list', {});
      try { await a.invoke('mission.create', { workspaceId: ws.id, title: 'x', goal: 'y', approvalMode: 'ask_risky', runtime: 'pi', model: '../../etc' }); } catch (e) { rejectedMission = (e as Error).message; }
      const m = await a.invoke('mission.create', { workspaceId: ws.id, title: 'Pinned model', goal: 'y', approvalMode: 'ask_risky', runtime: 'pi', model: s.values['models.default'] });
      return { values: s.values, creds: JSON.stringify(creds), rejected, rejectedMission, missionModel: m.model };
    });
    expect(state.values['models.default']).toBe(refs[0]);
    expect(state.values['models.strong']).toBe(refs[1]);
    expect(state.creds).not.toContain(KEY);
    expect(state.rejected).toBeTruthy();
    expect(state.rejectedMission).toBeTruthy();
    expect(state.missionModel).toBe(refs[0]);

    // The new-mission form offers the same models when Pi is the runtime.
    await page.getByRole('button', { name: 'New mission' }).first().click();
    const pick = page.getByTestId('mission-model');
    await expect(pick).toBeVisible();
    await expect(pick.locator('option', { hasText: 'From Settings' })).toHaveCount(1);
    expect(await pick.locator('option').count()).toBe(refs.length + 1);
  } finally { await app.close(); }
});
